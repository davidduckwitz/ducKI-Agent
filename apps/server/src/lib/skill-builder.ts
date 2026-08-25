import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validateSkillContent, validateSkillDirectory } from "@ducki/agent";

const SkillNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const ResourceSchema = z.object({
  path: z.string().min(1).max(180).refine((value) => /^(references|scripts|assets)\/[A-Za-z0-9._/-]+$/.test(value) && !value.split("/").includes(".."), "Resource must be under references/, scripts/ or assets/"),
  content: z.string().max(200_000),
});

export const SkillBuilderSpecSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(20).max(1024),
  instructions: z.string().min(40).max(80_000),
  compatibility: z.string().min(1).max(500).optional(),
  resources: z.array(ResourceSchema).max(20).default([]),
}).superRefine((spec, ctx) => {
  const paths = spec.resources.map((resource) => resource.path.toLowerCase());
  if (new Set(paths).size !== paths.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resources"], message: "Resource paths must be unique" });
  if (/^---\s*$/m.test(spec.instructions.slice(0, 20))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instructions"], message: "Frontmatter is system-owned; provide only the Markdown body" });
});

export type SkillBuilderSpec = z.infer<typeof SkillBuilderSpecSchema>;

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function renderSkillMarkdown(spec: SkillBuilderSpec): string {
  return [
    "---",
    `name: ${spec.name}`,
    `description: ${yamlString(spec.description.trim())}`,
    ...(spec.compatibility ? [`compatibility: ${yamlString(spec.compatibility.trim())}`] : []),
    "---",
    "",
    spec.instructions.trim(),
    "",
  ].join("\n");
}

export function previewSkill(specInput: unknown) {
  const spec = SkillBuilderSpecSchema.parse(specInput);
  return {
    spec,
    files: [
      { path: "SKILL.md", owner: "system" as const, content: renderSkillMarkdown(spec) },
      ...spec.resources.map((resource) => ({ ...resource, owner: "agent" as const })),
    ],
  };
}

export function createValidatedSkill(skillsRoot: string, specInput: unknown) {
  const { spec, files } = previewSkill(specInput);
  const finalDir = resolve(skillsRoot, spec.name);
  if (existsSync(finalDir)) throw new Error(`A skill named '${spec.name}' already exists`);
  const stagingRoot = resolve(skillsRoot, ".builder-staging");
  const stagingDir = resolve(stagingRoot, `${spec.name}-${randomUUID()}`);
  mkdirSync(stagingDir, { recursive: true });
  try {
    for (const file of files) {
      const target = resolve(stagingDir, file.path);
      const within = relative(stagingDir, target);
      if (within.startsWith("..") || isAbsolute(within)) throw new Error(`Resource escapes skill folder: ${file.path}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf8");
    }
    const skillContent = readFileSync(join(stagingDir, "SKILL.md"), "utf8");
    // Validate against the final directory name before the atomic rename. This is the same
    // content validator used by validateSkillDirectory/the loader, without the staging suffix.
    const validation = validateSkillContent(skillContent, spec.name);
    if (!validation.valid) throw new Error(validation.errors.map((issue) => `${issue.field}: ${issue.message}`).join("; "));
    mkdirSync(skillsRoot, { recursive: true });
    renameSync(stagingDir, finalDir);
    const finalValidation = validateSkillDirectory(finalDir);
    if (!finalValidation.valid) throw new Error(finalValidation.errors.map((issue) => `${issue.field}: ${issue.message}`).join("; "));
    return { name: spec.name, path: finalDir, files: files.map((file) => file.path), warnings: finalValidation.warnings, skillContent };
  } catch (error) {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}
