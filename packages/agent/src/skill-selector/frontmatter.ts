/**
 * Shared SKILL.md frontmatter parser.
 *
 * Single source of truth for reading YAML-style frontmatter across the server
 * (routes/skills.ts) and the skill registry. Written without a YAML dependency
 * on purpose: it supports exactly the subset the agentskills.io spec needs plus
 * this project's legacy fields, and it is robust against the two failure modes
 * that historically corrupted metadata here:
 *
 *   1. A UTF-8 BOM before the opening `---` (previous parsers checked
 *      `content.startsWith("---")` and silently dropped all frontmatter).
 *   2. CRLF line endings leaking `\r` into captured values
 *      (e.g. `name: "Auto Plan\"\r"`).
 *
 * Supported syntax:
 *   - Scalars:            key: value        (quotes optional)
 *   - Inline arrays:      key: [a, b, c]
 *   - Block arrays:       key:\n  - a\n  - b
 *   - One-level maps:     metadata:\n  author: x\n  version: "1.0"
 *
 * Anything deeper is intentionally out of scope; keep frontmatter flat.
 */

/**
 * Spec-conformant + legacy fields resolved into a single typed shape.
 * Legacy project fields (category, tags, *_skills, priority, version, scripts)
 * are read from either the top level (old skills) or the `metadata:` map (new,
 * agentskills.io-conformant skills), with the top level taking precedence.
 */
export interface NormalizedSkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  script?: string;
  category?: string;
  tags?: string[];
  dependencies?: string[];
  primarySkills?: string[];
  relatedSkills?: string[];
  fallbackSkills?: string[];
  priority?: string;
  scripts?: Record<string, string>;
  version?: string;
  /** The raw metadata map, always present (possibly empty). */
  metadata: Record<string, string>;
}

export interface ParsedFrontmatter {
  /** Raw key -> value map. Values are string | string[] | Record<string,string>. */
  data: Record<string, unknown>;
  /** Markdown body after the closing `---`. */
  body: string;
  /** True if a well-formed frontmatter block was found. */
  found: boolean;
}

/** Coerce a parsed value (array | comma/space string) into a string array. */
function toStringArray(value: unknown, separator: "comma" | "space" = "comma"): string[] | undefined {
  if (Array.isArray(value)) {
    const arr = value.map((v) => String(v).trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parts = separator === "space" ? value.trim().split(/\s+/) : value.split(",");
    const arr = parts.map((v) => v.trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  return undefined;
}

function toStr(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

/** Strip a leading UTF-8 BOM and normalize line endings to `\n`. */
export function normalizeSkillContent(content: string): string {
  return content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseInlineArray(value: string): string[] {
  const inner = value.slice(value.indexOf("[") + 1, value.lastIndexOf("]"));
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((item) => stripQuotes(item))
    .filter((item) => item.length > 0);
}

function indentWidth(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

/**
 * Parse the frontmatter block of a SKILL.md file.
 * Never throws; returns `found: false` with the original content as body when
 * no frontmatter is present.
 */
export function parseFrontmatter(rawContent: string): ParsedFrontmatter {
  const content = normalizeSkillContent(rawContent);

  if (!content.startsWith("---")) {
    return { data: {}, body: content, found: false };
  }

  // The opening delimiter must be a line of its own ("---" possibly padded).
  const firstNewline = content.indexOf("\n");
  if (firstNewline < 0 || content.slice(3, firstNewline).trim() !== "") {
    return { data: {}, body: content, found: false };
  }

  const closeIdx = content.indexOf("\n---", firstNewline);
  if (closeIdx < 0) {
    return { data: {}, body: content, found: false };
  }

  const block = content.slice(firstNewline + 1, closeIdx);
  // Body starts after the closing `---` line.
  const afterClose = content.indexOf("\n", closeIdx + 1);
  const body = afterClose < 0 ? "" : content.slice(afterClose + 1);

  const data: Record<string, unknown> = {};
  const lines = block.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    // Only top-level keys (no indentation) start a new entry.
    if (indentWidth(line) > 0) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const key = line.slice(0, colonIdx).trim();
    if (!key) continue;
    const rest = line.slice(colonIdx + 1).trim();

    // Inline array: key: [a, b]
    if (rest.startsWith("[") && rest.includes("]")) {
      data[key] = parseInlineArray(rest);
      continue;
    }

    // Scalar value present on the same line.
    if (rest.length > 0) {
      data[key] = stripQuotes(rest);
      continue;
    }

    // No inline value: look ahead for a nested block (array items or a map).
    const childItems: string[] = [];
    const childMap: Record<string, string> = {};
    let sawArray = false;
    let sawMap = false;
    let j = i + 1;

    for (; j < lines.length; j++) {
      const child = lines[j]!;
      if (!child.trim()) continue;
      if (indentWidth(child) === 0) break; // dedent -> end of nested block

      const trimmed = child.trim();
      if (trimmed.startsWith("- ") || trimmed === "-") {
        sawArray = true;
        const item = stripQuotes(trimmed.replace(/^-\s*/, ""));
        if (item) childItems.push(item);
      } else {
        const childColon = trimmed.indexOf(":");
        if (childColon > 0) {
          sawMap = true;
          const ck = trimmed.slice(0, childColon).trim();
          const cv = stripQuotes(trimmed.slice(childColon + 1));
          if (ck) childMap[ck] = cv;
        }
      }
    }

    if (sawArray) {
      data[key] = childItems;
    } else if (sawMap) {
      data[key] = childMap;
    } else {
      data[key] = "";
    }
    i = j - 1; // resume after the nested block
  }

  return { data, body, found: true };
}

/**
 * Resolve raw parsed frontmatter into the normalized shape used by the registry
 * and API. Reads legacy fields from either the top level or `metadata:`.
 */
export function normalizeFrontmatter(data: Record<string, unknown>): NormalizedSkillFrontmatter {
  const metaRaw = data.metadata;
  const metadata: Record<string, string> =
    metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)
      ? Object.fromEntries(Object.entries(metaRaw as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : {};

  // top-level value wins, then metadata.<key>
  const pick = (key: string): unknown => data[key] ?? metadata[key];

  const scriptsRaw = data.scripts;
  const scripts =
    scriptsRaw && typeof scriptsRaw === "object" && !Array.isArray(scriptsRaw)
      ? (Object.fromEntries(
          Object.entries(scriptsRaw as Record<string, unknown>).map(([k, v]) => [k, String(v)])
        ) as Record<string, string>)
      : undefined;

  return {
    name: toStr(data.name),
    description: toStr(data.description),
    license: toStr(data.license),
    compatibility: toStr(data.compatibility),
    allowedTools: toStringArray(data["allowed-tools"], "space"),
    script: toStr(data.script),
    category: toStr(pick("category")),
    tags: toStringArray(pick("tags")),
    dependencies: toStringArray(pick("dependencies")),
    primarySkills: toStringArray(pick("primary_skills")),
    relatedSkills: toStringArray(pick("related_skills")),
    fallbackSkills: toStringArray(pick("fallback_skills")),
    priority: toStr(pick("priority")),
    scripts,
    version: toStr(pick("version")),
    metadata,
  };
}

/** Convenience: parse + normalize in one call. */
export function readSkillFrontmatter(rawContent: string): {
  frontmatter: NormalizedSkillFrontmatter;
  body: string;
  found: boolean;
} {
  const { data, body, found } = parseFrontmatter(rawContent);
  return { frontmatter: normalizeFrontmatter(data), body, found };
}
