import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

const SAFE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SETTING_PREFIX = /^[A-Z][A-Z0-9_]*$/;
const BUILTIN_PROVIDER_IDS = new Set(["openai", "openrouter", "lmstudio", "ollama", "claude"]);

export const PluginBuilderSpecSchema = z.object({
  name: z.string().regex(SAFE_NAME).max(64),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1).max(1024),
  icon: z.string().max(16).optional(),
  category: z.enum(["overview", "workspace", "automation", "knowledge", "system"]),
  archetype: z.enum(["data-source", "storage-tool", "llm-provider", "widget"]),
  userRequest: z.string().min(1).max(10_000),
  targetHint: z.string().max(500).optional(),
  allowedHosts: z.array(z.string().min(1).max(253)).max(20).default([]),
  api: z.object({
    baseUrl: z.string().url().optional(),
    authentication: z.enum(["none", "api-key", "bearer"]).default("none"),
  }).optional(),
  llmProvider: z.object({
    protocol: z.literal("openai-compatible"),
    defaultBaseUrl: z.string().url(),
    defaultModel: z.string().min(1).max(200),
    apiKeyRequired: z.boolean().default(true),
    supportsStreaming: z.boolean().default(true),
    supportsTools: z.boolean().default(true),
    supportsVision: z.boolean().default(false),
  }).optional(),
  widgets: z.array(z.object({
    id: z.string().regex(SAFE_NAME).max(64),
    title: z.string().max(100).optional(),
    placement: z.enum(["dashboard", "sidebar-above-logo", "sidebar-before-mode", "sidebar-after-mode", "sidebar-content", "topbar", "footer"]),
    align: z.enum(["left", "center", "right", "full"]),
    frame: z.enum(["card", "borderless"]),
    background: z.enum(["card", "transparent", "inherit"]),
    height: z.number().int().min(20).max(800),
    width: z.union([z.enum(["auto", "sm", "md", "lg", "full"]), z.number().int().min(40).max(2000)]),
  })).max(12).optional(),
}).superRefine((spec, ctx) => {
  if (spec.archetype === "llm-provider" && !spec.llmProvider) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["llmProvider"], message: "LLM provider configuration is required" });
  }
  const providerId = spec.name.replace(/-provider$/, "");
  if (spec.archetype === "llm-provider" && BUILTIN_PROVIDER_IDS.has(providerId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["name"], message: `Provider id '${providerId}' is reserved by a built-in provider` });
  }
  if (spec.archetype === "data-source" && !spec.api?.baseUrl && !spec.targetHint) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["api", "baseUrl"], message: "A base URL or target hint is required" });
  }
  if (spec.archetype === "widget" && (!spec.widgets || spec.widgets.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["widgets"], message: "At least one widget is required" });
  }
  if (spec.widgets && new Set(spec.widgets.map((widget) => widget.id)).size !== spec.widgets.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["widgets"], message: "Widget ids must be unique" });
  }
});

export type PluginBuilderSpec = z.infer<typeof PluginBuilderSpecSchema>;

export interface PluginScaffoldFile {
  path: string;
  owner: "system" | "agent";
  purpose: string;
}

export interface PluginScaffoldResult {
  spec: PluginBuilderSpec;
  files: PluginScaffoldFile[];
  editableFiles: string[];
  lockedFiles: string[];
  hashes: Record<string, string>;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function settingPrefix(name: string): string {
  const prefix = name.replace(/-/g, "_").toUpperCase();
  if (!SETTING_PREFIX.test(prefix)) throw new Error(`Cannot derive setting prefix from '${name}'`);
  return prefix;
}

function safeHost(value: string): string | undefined {
  try { return new URL(value).hostname; } catch { return undefined; }
}

export function describePluginScaffold(input: unknown): PluginScaffoldResult {
  const spec = PluginBuilderSpecSchema.parse(input);
  const files: PluginScaffoldFile[] = [
    { path: "plugin.json", owner: "system", purpose: "Validated plugin manifest" },
    { path: "README.md", owner: "agent", purpose: "User-facing documentation" },
  ];
  if (spec.archetype === "data-source") {
    files.push(
      { path: `tools/${spec.name}.datasource.json`, owner: "agent", purpose: "Declarative API tool" },
      { path: `skills/${spec.name}-usage/SKILL.md`, owner: "agent", purpose: "Agent usage instructions" },
    );
  } else if (spec.archetype === "storage-tool") {
    files.push(
      { path: `tools/${spec.name}.tool.json`, owner: "agent", purpose: "Sandboxed storage tool" },
      { path: `skills/${spec.name}-usage/SKILL.md`, owner: "agent", purpose: "Agent usage instructions" },
    );
  } else if (spec.archetype === "llm-provider") {
    files.push(
      { path: "provider.js", owner: "system", purpose: "Locked host-adapter provider implementation" },
      { path: `skills/${spec.name}-usage/SKILL.md`, owner: "agent", purpose: "Provider usage notes" },
    );
  } else {
    for (const widget of spec.widgets ?? []) {
      files.push({ path: `widgets/${widget.id}/index.html`, owner: "agent", purpose: `${widget.placement} widget UI` });
    }
  }
  return {
    spec,
    files,
    editableFiles: files.filter((file) => file.owner === "agent").map((file) => file.path),
    lockedFiles: files.filter((file) => file.owner === "system").map((file) => file.path),
    hashes: {},
  };
}

function scaffoldContents(spec: PluginBuilderSpec): Record<string, string> {
  const description = spec.description.trim();
  const skillPath = `skills/${spec.name}-usage/SKILL.md`;
  const common = {
    name: spec.name,
    version: "1.0.0",
    description,
    icon: spec.icon || undefined,
    category: spec.category,
    enabled: true,
  };
  const readme = `# ${spec.displayName}\n\n${description}\n\n## Purpose\n\nTODO: Describe installation, settings and usage.\n`;
  const skill = `---\nname: ${spec.name}-usage\ndescription: Use the ${spec.displayName} plugin.\n---\n\n# ${spec.displayName}\n\nTODO: Document when and how the agent should use this plugin.\n`;

  if (spec.archetype === "data-source") {
    const baseUrl = spec.api?.baseUrl || spec.targetHint || "https://api.example.com";
    const host = safeHost(baseUrl);
    const allowedHosts = [...new Set([...spec.allowedHosts, ...(host ? [host] : [])])];
    return {
      "plugin.json": json({ ...common, provides: { dataSourceTools: [`tools/${spec.name}.datasource.json`], skills: [skillPath] }, allowedHosts }),
      [`tools/${spec.name}.datasource.json`]: json({
        name: spec.name.replace(/-/g, "_"), description, params: {}, defaults: {},
        requests: [{ urlTemplate: baseUrl }], response: { summaryTemplate: "TODO: Map the API response." },
        allowedHosts, cacheTtlMs: 300000,
      }),
      [skillPath]: skill,
      "README.md": readme,
    };
  }

  if (spec.archetype === "storage-tool") {
    return {
      "plugin.json": json({ ...common, provides: { scriptTools: [`tools/${spec.name}.tool.json`], skills: [skillPath] }, storage: { sqlite: true } }),
      [`tools/${spec.name}.tool.json`]: json({
        name: spec.name.replace(/-/g, "_"), description,
        parameters: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
        async: true,
        script: "// TODO: Use toolContext.storage and return a JSON-serializable result.\nreturn { action: toolInput.action };",
      }),
      [skillPath]: skill,
      "README.md": readme,
    };
  }

  if (spec.archetype === "widget") {
    const widgets = (spec.widgets ?? []).map((widget) => ({ ...widget, page: `widgets/${widget.id}/index.html` }));
    const contents: Record<string, string> = {
      "plugin.json": json({ ...common, provides: { widgets } }),
      "README.md": readme,
    };
    for (const widget of spec.widgets ?? []) {
      contents[`widgets/${widget.id}/index.html`] = `<!doctype html>\n<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:transparent;color:inherit;font-family:system-ui,sans-serif}body{display:flex;align-items:center;justify-content:center}</style></head><body><div>TODO: ${widget.title || widget.id}</div></body></html>\n`;
    }
    return contents;
  }

  const llm = spec.llmProvider!;
  const providerId = spec.name.replace(/-provider$/, "");
  const prefix = settingPrefix(providerId);
  const providerSource = `export function createProvider(config, context) {\n  if (!context.createOpenAICompatibleProvider) {\n    throw new Error("Host does not provide the OpenAI-compatible provider adapter");\n  }\n  return context.createOpenAICompatibleProvider({\n    baseUrl: config.baseUrl || ${JSON.stringify(llm.defaultBaseUrl)},\n    apiKey: config.apiKey,\n    model: config.model || ${JSON.stringify(llm.defaultModel)},\n  }, ${JSON.stringify(providerId)});\n}\n`;
  return {
    "plugin.json": json({
      ...common, trust: "node",
      provides: { llmProviders: [{
        id: providerId, name: spec.displayName, description, icon: spec.icon || undefined,
        module: "provider.js", modelSetting: `${prefix}_MODEL`, baseUrlSetting: `${prefix}_BASE_URL`,
        apiKeySetting: llm.apiKeyRequired ? `${prefix}_API_KEY` : undefined,
        defaultModel: llm.defaultModel, defaultBaseUrl: llm.defaultBaseUrl,
      }], skills: [skillPath] },
    }),
    "provider.js": providerSource,
    [skillPath]: skill,
    "README.md": readme,
  };
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createPluginScaffold(root: string, input: unknown): PluginScaffoldResult {
  const described = describePluginScaffold(input);
  const contents = scaffoldContents(described.spec);
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(contents)) {
    const target = resolve(root, rel);
    const within = relative(root, target);
    if (within.startsWith("..")) throw new Error(`Scaffold path escapes plugin root: ${rel}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  const hashes = Object.fromEntries(described.lockedFiles.map((rel) => [rel, digest(readFileSync(join(root, rel), "utf8"))]));
  return { ...described, hashes };
}

function listFiles(root: string, current = root): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const abs = join(current, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(root, abs));
    else if (entry.isFile()) result.push(relative(root, abs).replace(/\\/g, "/"));
  }
  return result;
}

export function validateScaffoldIntegrity(root: string, scaffold: PluginScaffoldResult): string[] {
  const errors: string[] = [];
  const expected = new Set(scaffold.files.map((file) => file.path));
  for (const rel of expected) if (!existsSync(join(root, rel)) || !statSync(join(root, rel)).isFile()) errors.push(`Required file missing: ${rel}`);
  for (const rel of listFiles(root)) if (!expected.has(rel)) errors.push(`Unexpected file created: ${rel}`);
  for (const [rel, expectedHash] of Object.entries(scaffold.hashes)) {
    if (!existsSync(join(root, rel))) continue;
    const actual = digest(readFileSync(join(root, rel), "utf8"));
    if (actual !== expectedHash) errors.push(`System-owned file was modified: ${rel}`);
  }
  return errors;
}
