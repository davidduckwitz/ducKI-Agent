import type { ToolResult, ToolExecutor } from "@ducki/shared";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, join, extname, relative } from "node:path";
import { globFiles, grepFiles } from "./filesystem-search.js";
import { outlineFile, renderOutline } from "./outline.js";
import { randomBytes } from "node:crypto";
import { SHARED_WORKSPACE_ROOT } from "./workspace-root.js";
import { stripStopMarkers } from "./content-sanitizer.js";

const SHARED_BASE_PATH = SHARED_WORKSPACE_ROOT;

/**
 * In-flight multi-part write state, keyed by resolved absolute path.
 *
 * A model that splits a large file across several calls (each part small enough to fit in
 * one response) can pass `totalParts` on the write and `partNumber`/`totalParts` on each
 * append. The tool then enforces that parts arrive exactly once, in order, without gaps:
 * a missing, duplicated or reordered part is a hard ERROR instead of a silently truncated
 * file - and the final part is only reported complete once every part has arrived.
 *
 * The state lives in memory for the process lifetime; a sequence that is never finished
 * is simply replaced by the next `write` to the same path.
 */
interface PartGroup {
  totalParts: number;
  received: number;
  next: number;
}

const partGroups = new Map<string, PartGroup>();

/**
 * Coerces/validates the optional `partNumber`/`totalParts` args. Returns either the parsed
 * pair or a descriptive error. Absent args (both undefined) mean "not a parted write".
 */
function parsePartArgs(input: Record<string, unknown>): {
  partNumber?: number;
  totalParts?: number;
  error?: string;
} {
  const rawNum = input["partNumber"];
  const rawTotal = input["totalParts"];
  if (rawNum === undefined && rawTotal === undefined) return {};
  const partNumber = rawNum === undefined ? undefined : Number(rawNum);
  const totalParts = rawTotal === undefined ? undefined : Number(rawTotal);
  if (rawNum !== undefined && (!Number.isInteger(partNumber) || (partNumber as number) < 1)) {
    return { error: "partNumber must be a positive integer (1-based part index) when provided." };
  }
  if (rawTotal !== undefined && (!Number.isInteger(totalParts) || (totalParts as number) < 1)) {
    return { error: "totalParts must be a positive integer (total number of parts) when provided." };
  }
  if (
    partNumber !== undefined &&
    totalParts !== undefined &&
    (partNumber as number) > (totalParts as number)
  ) {
    return { error: `partNumber (${partNumber}) cannot exceed totalParts (${totalParts}).` };
  }
  return { partNumber, totalParts };
}

/** Result payload for a part of a parted write, with guidance for the model's next step. */
function partResultData(
  filePath: string,
  partNumber: number,
  totalParts: number,
  received: number,
  done: boolean
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    path: filePath,
    part: { partNumber, totalParts, received },
  };
  data["note"] = done
    ? `All ${totalParts} parts received - the file is complete.`
    : `Part ${partNumber}/${totalParts} written (${received}/${totalParts} received). Send the next part with action:append partNumber:${partNumber + 1} totalParts:${totalParts}.`;
  return data;
}

/**
 * In-flight part sequences that are still missing parts - i.e. a parted write was started
 * (write totalParts=N) but not all parts have arrived yet. Used by the coding agent's
 * end-of-run check to warn the user that a file is incomplete instead of ending silently.
 * An optional filter narrows the report (e.g. to one sandbox root).
 */
export function listIncompletePartSequences(
  filter?: (path: string) => boolean
): Array<{ path: string; totalParts: number; received: number; next: number }> {
  const out: Array<{ path: string; totalParts: number; received: number; next: number }> = [];
  for (const [path, group] of partGroups) {
    if (group.received < group.totalParts && (!filter || filter(path))) {
      out.push({ path, totalParts: group.totalParts, received: group.received, next: group.next });
    }
  }
  return out;
}

/**
 * Drops in-flight part sequences for paths matching the filter (or all of them when no
 * filter is given). Called at the start of a coding run so a stale sequence from an earlier
 * crashed/stopped run is never reported as if this run started it. Returns the count removed.
 */
export function clearIncompletePartSequences(filter?: (path: string) => boolean): number {
  let removed = 0;
  for (const path of [...partGroups.keys()]) {
    if (!filter || filter(path)) {
      partGroups.delete(path);
      removed++;
    }
  }
  return removed;
}

export const FILESYSTEM_ACTIONS = [
  "read", "write", "append", "edit", "delete",
  "list", "mkdir", "exists", "stat", "move", "copy",
  "glob", "grep", "outline",
] as const;

export type FilesystemAction = typeof FILESYSTEM_ACTIONS[number];

/**
 * Field names a model may use for the body of a write/append.
 *
 * `content` is the documented one, but models reach for their own habits constantly -
 * Anthropic's text-editor tool uses `file_text`, others emit `text`, `contents` or `body`.
 */
export const FILE_CONTENT_FIELDS = [
  "content",
  "contents",
  "text",
  "file_text",
  "fileText",
  "fileContent",
  "file_contents",
  "data",
  "body",
] as const;

/**
 * Pulls the file body out of a tool call, whatever the model called the field and whatever
 * shape it used.
 *
 * This is the single source of truth for "does this write have content", deliberately exported
 * so the agent's preflight validation can apply the SAME rule. Those two used to disagree: the
 * tool accepted nine aliases while the preflight insisted on a literal string in `content`, so
 * a perfectly answerable write emitted as `file_text` was rejected before the tool ever saw it -
 * with an error message telling the model to do what it had effectively already done. The model
 * then repeated itself until the run was killed by the consecutive-failure guardrail.
 *
 * Shapes beyond a plain string are coerced only where the intent is unambiguous:
 * an array of lines is joined, a number or boolean is stringified. An object is serialised
 * ONLY for a .json target - writing JSON into a .ts file would be a silent corruption, and a
 * clear error is worth more there than a guess.
 */
export function extractFileContent(
  input: Record<string, unknown>,
  filePath?: string
): string | undefined {
  for (const field of FILE_CONTENT_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;

    if (typeof value === "string") return value;

    if (Array.isArray(value)) {
      // A list of lines is the single most common non-string shape.
      if (value.every((entry) => typeof entry === "string")) return (value as string[]).join("\n");
      if (filePath && /\.jsonc?$/i.test(filePath)) return JSON.stringify(value, null, 2);
      continue;
    }

    if (typeof value === "number" || typeof value === "boolean") return String(value);

    if (typeof value === "object") {
      if (filePath && /\.jsonc?$/i.test(filePath)) return JSON.stringify(value, null, 2);
      continue;
    }
  }
  return undefined;
}

/**
 * An empty file body is almost never what the model meant.
 *
 * The dominant producer is a TRUNCATED call: the model runs out of output budget partway
 * through a large file, leaving `{"action":"write","path":"a.md","content":"` - and the JSON
 * repair pass that rescues such fragments closes the dangling string, yielding `content: ""`.
 * Writing that produces a 0-byte file and reports success, which is the worst possible outcome:
 * the model believes the file exists, the user sees an empty one, and nothing complains.
 *
 * So an empty write must be explicit. `allowEmpty: true` still creates a genuinely empty file
 * (a placeholder, a touched marker file) - it just cannot happen by accident.
 */
export const EMPTY_CONTENT_ERROR =
  "Refusing to write an empty file. The 'content' field arrived empty, which almost always means " +
  "the tool call was cut off partway through the file (the model ran out of output budget) rather " +
  "than that an empty file was wanted. Re-send the write with the FULL content - prefer the block " +
  "form, which needs no escaping and survives long content: " +
  "[TOOL:filesystem action=write path=<path>]\\n<content>\\n[/TOOL] - or split a very large file " +
  "into one write plus several append calls.";
// Deliberately NOT mentioning the allowEmpty escape hatch here. This text is fed to the
// self-repair pass, whose job is to make errors go away - told about a flag that silences this
// one, it set it, and a truncated write became a successfully-written 0-byte file. The flag is
// documented in the tool's schema instead, where using it is a deliberate choice rather than a
// way out of a complaint.

/** True when the caller explicitly asked for an empty file rather than losing content to truncation. */
export function isIntentionalEmptyWrite(input: Record<string, unknown>): boolean {
  return input["allowEmpty"] === true;
}

/** Lines returned by `read` when the caller gives no explicit limit. */
const DEFAULT_READ_LINES = 2000;
/** Longest single line `read` returns verbatim before clipping it. */
const MAX_READ_LINE_CHARS = 2000;

/**
 * Undoes the `<n>: ` prefix that `read` adds, for the case where a model copies a snippet
 * straight out of a read result into an `edit`'s oldString.
 *
 * Deliberately all-or-nothing and only applied as a FALLBACK after the literal match failed
 * (see the edit action): a config file can legitimately contain a line like `8080: backend`,
 * and stripping that unconditionally would edit the wrong text. Requires every non-empty line
 * to carry the prefix and the numbers to ascend by one, which prose and real config never do.
 */
export function stripLineNumberPrefixes(text: string): string {
  const lines = text.split("\n");
  const numbers: number[] = [];
  const stripped: string[] = [];

  for (const line of lines) {
    if (line.trim() === "") {
      stripped.push(line);
      continue;
    }
    const match = /^\s*(\d+): (.*)$/.exec(line);
    if (!match) return text;
    numbers.push(Number(match[1]));
    stripped.push(match[2]!);
  }

  if (numbers.length === 0) return text;
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] !== numbers[i - 1]! + 1) return text;
  }
  return stripped.join("\n");
}

/** A matched span in ORIGINAL file coordinates. */
interface EditSpan {
  start: number;
  end: number;
}

/** All literal occurrences of `needle` in `haystack`. */
function literalSpans(haystack: string, needle: string): EditSpan[] {
  const spans: EditSpan[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    spans.push({ start: idx, end: idx + needle.length });
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return spans;
}

/**
 * Maps a position in the whitespace-normalized form of a file back to a position in the
 * ORIGINAL text. `lines` is the parallel table built by tolerantSpans(): each entry holds
 * the line's right-trimmed text and its start offset in the original. A position that lands
 * exactly at a line's trimmed end maps to that trimmed end (NOT past the stripped trailing
 * whitespace/`\r`), so the stripped noise survives the replacement untouched.
 */
function mapNormToOriginal(
  lines: Array<{ text: string; start: number }>,
  normPos: number
): number {
  let accNorm = 0;
  for (const line of lines) {
    if (normPos < accNorm + line.text.length) {
      return line.start + (normPos - accNorm);
    }
    if (normPos === accNorm + line.text.length) {
      return line.start + line.text.length;
    }
    accNorm += line.text.length + 1; // +1 for the "\n" separator
  }
  const last = lines[lines.length - 1]!;
  return last.start + last.text.length;
}

/**
 * Whitespace-tolerant edit matching (last resort, after the literal and line-number-prefix
 * tiers failed): matches per line, ignoring `\r` (CRLF files), trailing spaces/tabs and the
 * `<n>: ` prefixes `read` adds. The file is never blindly rewritten - the match is mapped
 * back to original coordinates and only the matched span is replaced.
 */
function tolerantSpans(original: string, oldString: string): EditSpan[] {
  const lines: Array<{ text: string; start: number }> = [];
  let pos = 0;
  for (const rawLine of original.split("\n")) {
    lines.push({ text: rawLine.replace(/\r$/, "").replace(/[ \t]+$/, ""), start: pos });
    pos += rawLine.length + 1;
  }
  const normalizedOriginal = lines.map((l) => l.text).join("\n");
  const prefixStripped = stripLineNumberPrefixes(oldString);
  const oldForNormalize = prefixStripped !== oldString ? prefixStripped : oldString;
  const normalizedOld = oldForNormalize
    .split("\n")
    .map((l) => l.replace(/\r$/, "").replace(/[ \t]+$/, ""))
    .join("\n");
  if (normalizedOld === oldString && normalizedOriginal === original) return [];

  const spans: EditSpan[] = [];
  let idx = normalizedOriginal.indexOf(normalizedOld);
  while (idx !== -1) {
    spans.push({
      start: mapNormToOriginal(lines, idx),
      end: mapNormToOriginal(lines, idx + normalizedOld.length),
    });
    idx = normalizedOriginal.indexOf(normalizedOld, idx + normalizedOld.length);
  }
  return spans;
}

/** Levenshtein-based similarity in [0,1] for two short strings (line-level). */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const cols = b.length + 1;
  let prev = new Array(cols).fill(0) as number[];
  let cur = new Array(cols).fill(0) as number[];
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return 1 - prev[cols - 1]! / Math.max(a.length, b.length);
}

/** Minimum average per-line similarity for a fuzzy edit match to be applied. */
const FUZZY_EDIT_THRESHOLD = 0.7;
/** How much better the best position must be than the runner-up to avoid ambiguity. */
const FUZZY_AMBIGUITY_MARGIN = 0.05;

/**
 * Last-resort edit matching: slides the (normalized) oldString over the freshly read file
 * line by line and, if one position matches well enough (and clearly better than any
 * runner-up), returns the span of that block in ORIGINAL coordinates plus the text it
 * actually matched. Used only when the literal, prefix-stripped and whitespace-tolerant
 * tiers all failed - i.e. the model's snippet is stale or slightly off. This is the tool's
 * own "fresh read + corrected retry": the file content is read at call time, the best
 * matching block is located, and only that span is replaced.
 */
function fuzzyEditSpans(
  original: string,
  oldString: string
): { spans: EditSpan[] | null; similarity: number; matchedText: string | null } {
  const lines: Array<{ text: string; start: number }> = [];
  let pos = 0;
  for (const rawLine of original.split("\n")) {
    lines.push({ text: rawLine.replace(/\r$/, "").replace(/[ \t]+$/, ""), start: pos });
    pos += rawLine.length + 1;
  }
  const oldLines = oldString.split("\n").map((l) => l.replace(/\r$/, "").replace(/[ \t]+$/, ""));
  if (oldLines.length === 0 || oldLines.length > lines.length) {
    return { spans: null, similarity: 0, matchedText: null };
  }

  let bestStart = -1;
  let bestScore = 0;
  let secondScore = 0;
  for (let start = 0; start + oldLines.length <= lines.length; start++) {
    let sum = 0;
    for (let k = 0; k < oldLines.length; k++) {
      sum += lineSimilarity(oldLines[k]!, lines[start + k]!.text);
    }
    const score = sum / oldLines.length;
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestStart = start;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (bestStart < 0 || bestScore < FUZZY_EDIT_THRESHOLD) {
    return { spans: null, similarity: bestScore, matchedText: null };
  }
  if (bestScore - secondScore < FUZZY_AMBIGUITY_MARGIN) {
    return { spans: null, similarity: bestScore, matchedText: null };
  }

  const first = lines[bestStart]!;
  const last = lines[bestStart + oldLines.length - 1]!;
  const start = first.start;
  const end = last.start + last.text.length;
  return {
    spans: [{ start, end }],
    similarity: bestScore,
    matchedText: original.slice(start, end),
  };
}

interface PathOptions {
  basePath?: string;
  safeMode: boolean;
}

function normalizeForCompare(value: string): string {
  return resolve(value).replace(/\\+/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isInsideBase(basePath: string, candidatePath: string): boolean {
  const base = normalizeForCompare(basePath);
  const candidate = normalizeForCompare(candidatePath);
  return candidate === base || candidate.startsWith(`${base}/`);
}

/**
 * Type of a path, without throwing for a missing one.
 *
 * Several actions used to check only `existsSync` and then hand the path straight to a
 * file-only fs call, so pointing them at a directory surfaced a raw Node errno
 * ("EISDIR: illegal operation on a directory, read") that tells the agent nothing about
 * what to do instead.
 */
function pathKind(candidate: string): "file" | "directory" | "other" | "missing" {
  try {
    const stats = statSync(candidate);
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}

/**
 * Renders a search hit as a path the model can hand straight back to `read`.
 *
 * Relative to the SCOPE ROOT (the sandbox, or the shared workspace), never to the directory
 * that happened to be searched. Those two differ the moment a search is narrowed to a
 * subfolder: a `grep` under `scripts/` would report `foo.js`, and the follow-up
 * `read("foo.js")` resolves against the workspace root and finds nothing. Reporting against
 * the same base that every path is resolved against makes the result round-trip by
 * construction, and still costs a fraction of an absolute path repeated across hundreds of hits.
 */
function toDisplayPath(absolutePath: string, scopeRoot: string): string {
  const rel = relative(scopeRoot, absolutePath).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : absolutePath;
}

function listDirectory(dirPath: string): Array<{ name: string; type: string; path: string }> {
  return readdirSync(dirPath, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : "file",
    path: join(dirPath, entry.name),
  }));
}

function validateContent(filePath: string, content: string): string | undefined {
  if (extname(filePath).toLowerCase() === ".json") {
    try {
      JSON.parse(content);
    } catch (error) {
      return `Refusing to write invalid JSON to ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  return undefined;
}

/**
 * Writes content via temp-file + rename (atomic on the same volume) and keeps
 * a .bak copy of the previous version, so a truncated/garbled LLM completion
 * can never leave the target file half-written and the prior version is
 * always recoverable.
 */
function atomicWrite(filePath: string, content: string): void {
  if (existsSync(filePath)) {
    copyFileSync(filePath, `${filePath}.bak`);
  }
  const tmpPath = join(dirname(filePath), `.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmpPath, content, "utf8");
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

const ABSOLUTE_PATH_RE = /^[A-Za-z]:\\|^\\\\|^\//;

const REDUNDANT_LEADING_SEGMENT = "shared-workspace";

/**
 * Strips a redundant leading `shared-workspace/` prefix from a relative path when the base it will be
 * joined onto already ends in that segment.
 *
 * The model is told to address files as `./shared-workspace/scripts/foo.js`, but the workspace base is
 * itself `…/shared-workspace`. Joining them naively produced `…/shared-workspace/shared-workspace/scripts`.
 * Only the literal `shared-workspace` segment is stripped (not arbitrary base names) so a coding sandbox
 * whose folder happens to be named like a real subdir — e.g. a project slug `src` — is never affected,
 * and only when the base ends in that segment, so a legitimately nested `shared-workspace` folder is
 * still reachable (address it twice).
 */
function stripRedundantBaseSegment(relative: string, base: string): string {
  const normalized = relative.replace(/\\+/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  const baseTail = base.replace(/\\+/g, "/").replace(/\/+$/, "").split("/").pop()?.toLowerCase();
  if (baseTail !== REDUNDANT_LEADING_SEGMENT) return normalized;
  const segments = normalized.split("/");
  if (segments[0]?.toLowerCase() === REDUNDANT_LEADING_SEGMENT) {
    segments.shift();
  }
  return segments.join("/");
}

/** The base every relative path is resolved against - the same choice resolvePath makes. */
function displayScopeRoot(basePath: string | undefined): string {
  return basePath ? resolve(basePath) : SHARED_BASE_PATH;
}

function resolvePath(inputPath: string, options: PathOptions): string {
  const trimmed = String(inputPath ?? "").trim();
  const scopedBase = options.basePath ? resolve(options.basePath) : undefined;
  const isAbsolute = ABSOLUTE_PATH_RE.test(trimmed);

  // Coding agent: a basePath is always supplied and the path is confined to that sandbox.
  if (scopedBase) {
    const resolved = isAbsolute
      ? resolve(trimmed)
      : resolve(scopedBase, stripRedundantBaseSegment(trimmed, scopedBase));

    if (!options.safeMode) return resolved;
    if (!isInsideBase(scopedBase, resolved)) {
      throw new Error(`Path is outside basePath scope: ${trimmed}`);
    }
    return resolved;
  }

  // Normal agent: no basePath. Rebase relative paths ONTO the workspace root (rather than resolving
  // them against process.cwd() and merely rejecting the result) so a path like "scripts/foo.js" — or
  // the "./shared-workspace/scripts" convention — always lands inside the workspace regardless of cwd.
  const resolved = isAbsolute
    ? resolve(trimmed)
    : resolve(SHARED_BASE_PATH, stripRedundantBaseSegment(trimmed, SHARED_BASE_PATH));

  if (!options.safeMode) return resolved;

  if (!isInsideBase(SHARED_BASE_PATH, resolved)) {
    throw new Error(`Path is outside shared workspace: ${trimmed}. Use /api/shared or a path under ${SHARED_BASE_PATH}`);
  }

  return resolved;
}

export const filesystemTool: ToolExecutor = {
  name: "filesystem",
  description:
    "Read, write, delete, list files and directories. REQUIRED: Always provide 'action' and 'path'. " +
    "Use 'list' for directories and 'read' for files - if you are unsure what a path is, call 'stat' or 'list' first.",
  definition: {
    name: "filesystem",
    description:
      "File system operations. Required parameters: action (the operation), path (file/directory path). " +
      "All paths are scoped to shared-workspace for safety. " +
      "Directories and files take different actions: list/mkdir operate on directories, read/write/append/edit/copy operate on files.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "write", "append", "edit", "delete", "list", "mkdir", "exists", "stat", "move", "copy", "glob", "grep", "outline"],
          description:
            "Operation to perform: read (content of a SINGLE FILE - for a directory use list instead), " +
            "write (create/overwrite file), append (add to file), " +
            "edit (replace an exact substring in an existing file - PREFER this over write for changes to existing files), " +
            "delete (remove; needs recursive:true for a directory), " +
            "list (contents of a DIRECTORY - use this for paths like ./shared-workspace), mkdir (create directory), " +
            "exists (check if exists), stat (file info incl. isDirectory - use when unsure), move (rename/move), " +
            "copy (duplicate a single file), glob (find files by pattern under path), grep (search file contents by regex under path)",
        },
        path: {
          type: "string",
          description:
            "REQUIRED: Full file or directory path. Examples: /shared-workspace/config.json, ./data/file.txt, data/subfolder/. " +
            "A path without a file extension is usually a directory - use action:'list' for it. Must be provided.",
        },
        content: { type: "string", description: "Content to write (for write/append). Use actual line breaks (newlines) in multiline content - each line should be on a separate line, not escaped as \\n." },
        offset: { type: "number", description: "For read: first line to return (0-indexed, default 0)" },
        limit: { type: "number", description: "For read: maximum number of lines to return (default 2000)" },
        maxBytes: { type: "number", description: "For read: byte cap before truncation (default 262144 = 256KB)" },
        raw: { type: "boolean", default: false, description: "For read: return the file verbatim, without line-number prefixes." },
        pattern: { type: "string", description: "For glob: file path pattern (e.g. **/*.ts). For grep: regex to search." },
        filePattern: { type: "string", description: "For grep: optional glob pattern to restrict which files to search" },
        caseSensitive: { type: "boolean", default: false, description: "For grep: case-sensitive match (default false)" },
        maxResults: { type: "number", description: "For glob/grep: maximum results to return (default: 1000 for glob, 500 for grep)" },
        includeIgnored: { type: "boolean", default: false, description: "For glob/grep: also search node_modules, .git, dist, build output and .gitignore'd paths. Off by default - leave it off unless you specifically need a dependency's source." },
        oldString: { type: "string", description: "For edit: exact existing text to replace, WITHOUT the '<n>: ' line-number prefixes that read adds. Must match exactly once unless replaceAll is set." },
        newString: { type: "string", description: "For edit: text to replace oldString with." },
        replaceAll: { type: "boolean", default: false, description: "For edit: replace every occurrence of oldString instead of requiring a unique match." },
        encoding: { type: "string", default: "utf8" },
        recursive: { type: "boolean", default: false },
        destination: { type: "string", description: "Destination path for move action" },
        basePath: { type: "string", description: "Optional base path to scope relative paths" },
        safeMode: { type: "boolean", default: true, description: "Reject paths outside allowed scope/basePath" },
        dryRun: { type: "boolean", default: false, description: "Validate and report action without changing files" },
        createDirs: { type: "boolean", default: true, description: "Create parent directories for write/append/move destination" },
        overwrite: { type: "boolean", default: true, description: "Allow overwriting existing file on write" },
        allowEmpty: { type: "boolean", default: false, description: "For write/append: permit empty content. Only set this when a 0-byte file is genuinely intended - otherwise an empty body is treated as a truncated call and refused." },
        totalParts: { type: "number", description: "For write/append of a file split across multiple calls (each part small enough to fit in one response): the TOTAL number of parts. Pass it on the write (which is always part 1) and on every append of the sequence. The tool verifies that parts arrive exactly once, in order, without gaps, and only reports the file complete when ALL parts have arrived." },
        partNumber: { type: "number", description: "For write/append of a file split across multiple calls: this part's 1-based index. write is always part 1; parts 2..totalParts go through action:append with partNumber. Omitting both partNumber and totalParts means a single, self-contained write/append." },
      },
      required: ["action", "path"],
    },
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = String(input["action"] ?? "");
    const safeMode = (input["safeMode"] as boolean | undefined) ?? true;
    const dryRun = (input["dryRun"] as boolean | undefined) ?? false;
    const createDirs = (input["createDirs"] as boolean | undefined) ?? true;
    const overwrite = (input["overwrite"] as boolean | undefined) ?? true;
    // Field aliases and non-string shapes are resolved by the shared extractor, so the agent's
    // preflight validation applies exactly the same rule (see extractFileContent).
    let content = extractFileContent(input, String(input["path"] ?? ""));
    const recursive = (input["recursive"] as boolean | undefined) ?? false;

    // De-escape literal \n, \t, \r escape sequences (from JSON string parsing)
    // ONLY convert actual escape sequences, not random 'n' characters - other patterns break code
    if (content !== undefined) {
      content = content
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r");
      // Cut off any leaked tool-call / stop-token syntax a weak model mangled into
      // the content string (no-op unless a marker is actually present).
      content = stripStopMarkers(content) as string;
    }

    try {
      const filePath = resolvePath(String(input["path"] ?? ""), {
        basePath: input["basePath"] as string | undefined,
        safeMode,
      });

      switch (action) {
        case "read": {
          const kind = pathKind(filePath);
          if (kind === "missing") {
            return { success: false, data: null, error: `File not found: ${filePath}` };
          }
          // Reading a directory is a plausible thing for an agent to try. Answer with the
          // listing it was after instead of failing the turn, and name the right action.
          if (kind === "directory") {
            const entries = listDirectory(filePath);
            return {
              success: true,
              data: {
                path: filePath,
                isDirectory: true,
                entries,
                count: entries.length,
                note: `'${filePath}' is a directory, not a file - its contents are listed above. Use action:"list" for directories, or action:"read" on one of the entry paths.`,
              },
            };
          }
          const offset = Math.max(0, (input["offset"] as number | undefined) ?? 0);
          const limit = (input["limit"] as number | undefined) ?? DEFAULT_READ_LINES;
          const maxBytes = (input["maxBytes"] as number | undefined) ?? 262144;
          // Programmatic callers that need the file byte-for-byte (no line numbers, no
          // range footer) opt out here; the agent-facing default is the numbered form.
          const rawMode = input["raw"] === true;

          const raw = readFileSync(filePath, "utf8");
          const lines = raw.split("\n");
          const totalLines = lines.length;
          const sliced = lines.slice(offset, offset + limit);
          const shownTo = offset + sliced.length;
          const remaining = totalLines - shownTo;

          if (rawMode) {
            const text = sliced.join("\n");
            if (text.length > maxBytes) {
              return { success: true, data: `${text.slice(0, maxBytes)}\n[... truncated at ${maxBytes} bytes]` };
            }
            return { success: true, data: text };
          }

          // Line numbers let the model address a region precisely on the next read and map
          // compiler/linter output (which is always "file(line,col)") straight onto content.
          // A single minified line would otherwise blow the whole budget, so cap line width.
          const numbered = sliced
            .map((line, index) => {
              const body = line.length > MAX_READ_LINE_CHARS
                ? `${line.slice(0, MAX_READ_LINE_CHARS)} …[line truncated, ${line.length} chars total]`
                : line;
              return `${offset + index + 1}: ${body}`;
            })
            .join("\n");

          const footer = remaining > 0
            ? `\n[lines ${offset + 1}-${shownTo} of ${totalLines}. ${remaining} more - re-read with offset:${shownTo} for the next block, or use action:"grep" to jump straight to what you need.]`
            : offset > 0
              ? `\n[lines ${offset + 1}-${shownTo} of ${totalLines}]`
              : "";

          if (numbered.length > maxBytes) {
            return {
              success: true,
              data:
                numbered.slice(0, maxBytes) +
                `\n[... truncated: file is ${raw.length} bytes (${totalLines} lines), showing first ${maxBytes}. Use offset/limit to read specific sections.]`,
            };
          }

          return { success: true, data: numbered + footer };
        }

        case "write": {
          // Empty is refused separately from missing, with its own diagnosis - see
          // EMPTY_CONTENT_ERROR for why a 0-byte write is almost always a truncated call.
          if (content === "" && !isIntentionalEmptyWrite(input)) {
            return { success: false, data: null, error: EMPTY_CONTENT_ERROR };
          }
          if (content === undefined) {
            return {
              success: false,
              data: null,
              error:
                "Content required for write. You called this tool with action:'write' but no 'content' string. " +
                "If emitting a structured/native tool call, put the full file content as a plain JSON string in the 'content' argument " +
                "(escape newlines as \\n, quotes as \\\"). If using the [TOOL:...] text format, prefer the block form instead - it takes " +
                "the content verbatim with no escaping: [TOOL:filesystem action=write path=<path>]\\n<content>\\n[/TOOL]",
            };
          }
          if (!overwrite && existsSync(filePath)) {
            return { success: false, data: null, error: `File already exists: ${filePath}` };
          }
          const dir = dirname(filePath);
          if (!existsSync(dir) && createDirs) mkdirSync(dir, { recursive: true });
          if (!existsSync(dir) && !createDirs) {
            return { success: false, data: null, error: `Parent directory does not exist: ${dir}` };
          }
          // Parted write: `write` always establishes part 1 of a `totalParts` sequence (see
          // parsePartArgs/partGroups). A write without part args is a fresh, self-contained
          // intent and clears any stale in-flight sequence for this path.
          const part = parsePartArgs(input);
          if (part.error) return { success: false, data: null, error: part.error };
          if (part.totalParts !== undefined && part.partNumber !== undefined && part.partNumber !== 1) {
            return {
              success: false,
              data: null,
              error:
                `action:write always establishes part 1 - it cannot write part ${part.partNumber} of ${part.totalParts}. ` +
                `Write the first part, then send the remaining parts with action:append partNumber:${part.partNumber} totalParts:${part.totalParts}.`,
            };
          }
          // An intermediate part of a split file is not yet a valid whole (e.g. a JSON file
          // is only parseable once every part has arrived) - validate only single calls and
          // the FINAL assembled result (totalParts === 1 is complete on its own).
          const validationError = validateContent(filePath, content);
          if (validationError && (part.totalParts === undefined || part.totalParts === 1)) {
            return { success: false, data: null, error: validationError };
          }
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, path: filePath, bytes: content.length } };
          }
          if (part.totalParts !== undefined) {
            partGroups.set(filePath, { totalParts: part.totalParts, received: 1, next: 2 });
          } else {
            partGroups.delete(filePath);
          }
          atomicWrite(filePath, content);
          if (part.totalParts !== undefined && part.totalParts === 1) {
            // A single-part "sequence" is complete the moment it is written.
            partGroups.delete(filePath);
            return { success: true, data: partResultData(filePath, 1, 1, 1, true) };
          }
          if (part.totalParts !== undefined) {
            return { success: true, data: partResultData(filePath, 1, part.totalParts, 1, false) };
          }
          return { success: true, data: { path: filePath, bytes: content.length } };
        }

        case "append": {
          // Appending nothing is a no-op that would still report success - same trap.
          if (content === "" && !isIntentionalEmptyWrite(input)) {
            return { success: false, data: null, error: EMPTY_CONTENT_ERROR };
          }
          if (content === undefined) {
            return {
              success: false,
              data: null,
              error:
                "Content required for append. You called this tool with action:'append' but no 'content' string. " +
                "If emitting a structured/native tool call, put the content to append as a plain JSON string in the 'content' argument " +
                "(escape newlines as \\n, quotes as \\\"). If using the [TOOL:...] text format, prefer the block form instead - it takes " +
                "the content verbatim with no escaping: [TOOL:filesystem action=append path=<path>]\\n<content>\\n[/TOOL]",
            };
          }
          const dir = dirname(filePath);
          if (!existsSync(dir) && createDirs) mkdirSync(dir, { recursive: true });
          if (!existsSync(dir) && !createDirs) {
            return { success: false, data: null, error: `Parent directory does not exist: ${dir}` };
          }
          if (pathKind(filePath) === "directory") {
            return { success: false, data: null, error: `Cannot append: '${filePath}' is a directory, not a file.` };
          }

          // Parted write: validate against the in-flight sequence BEFORE touching the file.
          // The final part is only acknowledged once every part has arrived - a gap, a
          // duplicate or a reordered part is a hard error, never a silently truncated file.
          const part = parsePartArgs(input);
          if (part.error) return { success: false, data: null, error: part.error };
          const group = partGroups.get(filePath);
          const partOfSequence = part.partNumber !== undefined || part.totalParts !== undefined;
          if (partOfSequence) {
            if (!group) {
              return {
                success: false,
                data: null,
                error:
                  "No part sequence is in progress for this file. Start it with action:write " +
                  `path=${filePath.split(/[\\/]/).pop()} totalParts=N (write is part 1), then append the rest with partNumber/totalParts.`,
              };
            }
            if (part.totalParts !== undefined && part.totalParts !== group.totalParts) {
              return {
                success: false,
                data: null,
                error: `totalParts mismatch: the sequence expects ${group.totalParts} parts, but this call says ${part.totalParts}.`,
              };
            }
            if (part.partNumber === undefined) {
              return {
                success: false,
                data: null,
                error: `partNumber is required when a part sequence (totalParts=${group.totalParts}) is in progress. The next part is ${group.next}.`,
              };
            }
            if (part.partNumber !== group.next) {
              const error =
                part.partNumber < group.next
                  ? `Duplicate or out-of-order part: expected part ${group.next} of ${group.totalParts}, got part ${part.partNumber}.`
                  : `Gap detected: expected part ${group.next} of ${group.totalParts}, got part ${part.partNumber} - the missing part(s) were never written.`;
              return { success: false, data: null, error };
            }
          } else if (group) {
            return {
              success: false,
              data: null,
              error:
                `A part sequence is in progress for this file (expected part ${group.next} of ${group.totalParts}). ` +
                `Pass partNumber:${group.next} and totalParts:${group.totalParts} on this append, or restart the file with action:write totalParts:1.`,
            };
          }
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, path: filePath, bytes: content.length } };
          }
          const previous = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
          const combined = previous + content;
          // Intermediate parts of a split file are not yet a valid whole - validate the
          // assembled result only on the final part (and on plain appends).
          const isFinalPart = group !== undefined && part.partNumber === group.totalParts;
          const validationError = validateContent(filePath, combined);
          if (validationError && (!group || isFinalPart)) {
            return { success: false, data: null, error: validationError };
          }
          atomicWrite(filePath, combined);
          if (group) {
            // partNumber is validated above (the sequence branch requires it and matches
            // group.next), so it is defined here.
            const partNumber = part.partNumber!;
            group.received++;
            group.next = partNumber + 1;
            if (partNumber === group.totalParts) {
              const done = partResultData(filePath, partNumber, group.totalParts, group.received, true);
              partGroups.delete(filePath);
              return { success: true, data: done };
            }
            return {
              success: true,
              data: partResultData(filePath, partNumber, group.totalParts, group.received, false),
            };
          }
          return { success: true, data: { path: filePath } };
        }

        case "edit": {
          let oldString = input["oldString"] as string | undefined;
          let newString = input["newString"] as string | undefined;
          const replaceAll = (input["replaceAll"] as boolean | undefined) ?? false;

          // De-escape newString and oldString
          if (newString) {
            newString = newString
              .replace(/\\n/g, "\n")
              .replace(/\\t/g, "\t")
              .replace(/\\r/g, "\r");
            newString = stripStopMarkers(newString) as string;
          }
          if (oldString) {
            oldString = oldString
              .replace(/\\n/g, "\n")
              .replace(/\\t/g, "\t")
              .replace(/\\r/g, "\r");
          }
          if (!oldString) return { success: false, data: null, error: "oldString required for edit" };
          if (newString === undefined) return { success: false, data: null, error: "newString required for edit" };
          const editKind = pathKind(filePath);
          if (editKind === "missing") {
            return { success: false, data: null, error: `File not found: ${filePath}` };
          }
          if (editKind === "directory") {
            return {
              success: false,
              data: null,
              error: `Cannot edit: '${filePath}' is a directory, not a file. Use action:"list" to see its contents and edit a file inside it.`,
            };
          }
          // Editing a file invalidates any in-flight part sequence for it - the numbering
          // no longer describes the file's content.
          partGroups.delete(filePath);
          const original = readFileSync(filePath, "utf8");

          // Keep a CRLF file consistent: when the file's dominant line ending is CRLF, convert
          // the inserted text so we don't mix EOL styles mid-file.
          const crlfCount = (original.match(/\r\n/g) ?? []).length;
          const lfOnlyCount = (original.match(/\n/g) ?? []).length - crlfCount;
          if (crlfCount > lfOnlyCount && newString.includes("\n")) {
            newString = newString.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
          }

          // Matching tiers, each only tried after the previous one found nothing:
          //   1. literal           - the fast, exact path
          //   2. prefix-stripped   - `read` returns numbered lines; a model copying a snippet
          //      verbatim brings the "12: " prefixes with it. All-or-nothing (see helper).
          //   3. whitespace-tolerant - ignores `\r` (CRLF files), trailing spaces/tabs and the
          //      line-number prefixes, matched per line and mapped back to original
          //      coordinates. Never a blind rewrite - only the matched span is replaced.
          //   4. fuzzy             - the model's snippet is stale or slightly off (nothing above
          //      matched, so the file clearly changed since its read): slide the oldString over
          //      the freshly read file and, if one block matches well enough and unambiguously,
          //      correct the oldString automatically. Disabled for replaceAll (too ambiguous).
          let spans = literalSpans(original, oldString);
          let matchedMode: "literal" | "stripped-prefixes" | "normalized-whitespace" | "fuzzy" = "literal";
          if (spans.length === 0) {
            const destripped = stripLineNumberPrefixes(oldString);
            if (destripped !== oldString) {
              spans = literalSpans(original, destripped);
              if (spans.length > 0) matchedMode = "stripped-prefixes";
            }
          }
          if (spans.length === 0) {
            spans = tolerantSpans(original, oldString);
            if (spans.length > 0) matchedMode = "normalized-whitespace";
          }
          let fuzzyResult: { spans: EditSpan[] | null; similarity: number; matchedText: string | null } | undefined;
          if (spans.length === 0 && !replaceAll) {
            fuzzyResult = fuzzyEditSpans(original, oldString);
            if (fuzzyResult.spans) {
              spans = fuzzyResult.spans;
              matchedMode = "fuzzy";
            }
          }

          if (spans.length === 0) {
            const similarityHint =
              fuzzyResult !== undefined && fuzzyResult.similarity > 0.3
                ? ` The closest line-block matched the current file content at only ${(fuzzyResult.similarity * 100).toFixed(0)}% - the snippet has drifted too far from what is in the file now.`
                : "";
            return {
              success: false,
              data: null,
              error:
                `oldString not found in file: ${filePath} (${original.split("\n").length} lines). ` +
                `The text must match the file EXACTLY: re-read the relevant lines with action:"read" and copy ` +
                `them verbatim - WITHOUT the "<n>: " line-number prefixes and WITHOUT the "[lines ...]" footer. ` +
                `If the file changed since your last read (an earlier edit or another tool modified it), the old ` +
                `text no longer exists - base the edit on a FRESH read. The tool tolerates line endings and ` +
                `trailing spaces, but not missing or changed indentation, different words, or stale content.` +
                similarityHint,
            };
          }
          if (spans.length > 1 && !replaceAll) {
            return {
              success: false,
              data: null,
              error: `oldString is not unique (${spans.length} matches) in ${filePath}. Provide more surrounding context or set replaceAll:true.`,
            };
          }

          // Apply right-to-left so earlier offsets stay valid after each replacement.
          let updated = original;
          if (replaceAll) {
            for (let i = spans.length - 1; i >= 0; i--) {
              const { start, end } = spans[i]!;
              updated = updated.slice(0, start) + newString + updated.slice(end);
            }
          } else {
            const { start, end } = spans[0]!;
            updated = updated.slice(0, start) + newString + updated.slice(end);
          }
          const validationError = validateContent(filePath, updated);
          if (validationError) return { success: false, data: null, error: validationError };
          // A fuzzy match corrected the model's stale oldString - report what was actually
          // matched so the model can learn from the drift.
          const fuzzyExtra =
            matchedMode === "fuzzy" && fuzzyResult?.spans && fuzzyResult.matchedText !== null
              ? { similarity: fuzzyResult.similarity, matchedText: fuzzyResult.matchedText }
              : {};
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, path: filePath, occurrences: spans.length, matchedMode, ...fuzzyExtra } };
          }
          atomicWrite(filePath, updated);
          return { success: true, data: { path: filePath, occurrences: spans.length, matchedMode, ...fuzzyExtra } };
        }

        case "delete": {
          // Deleting a file kills any in-flight part sequence for it - a later append must
          // not silently rebuild the file from a single remaining part.
          partGroups.delete(filePath);
          if (!existsSync(filePath)) {
            return { success: false, data: null, error: `Path not found: ${filePath}` };
          }
          if (!recursive && pathKind(filePath) === "directory") {
            return {
              success: false,
              data: null,
              error: `'${filePath}' is a directory. Pass recursive:true to delete it and everything inside.`,
            };
          }
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, path: filePath, recursive } };
          }
          rmSync(filePath, { recursive });
          return { success: true, data: { deleted: filePath } };
        }

        case "list": {
          const listKind = pathKind(filePath);
          if (listKind === "missing") {
            return { success: false, data: null, error: `Directory not found: ${filePath}` };
          }
          // The mirror image of read-on-a-directory: readdirSync would throw ENOTDIR.
          if (listKind === "file") {
            return {
              success: false,
              data: null,
              error: `'${filePath}' is a file, not a directory. Use action:"read" to read its contents.`,
            };
          }
          return { success: true, data: listDirectory(filePath) };
        }

        case "mkdir": {
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, path: filePath } };
          }
          mkdirSync(filePath, { recursive: true });
          return { success: true, data: { created: filePath } };
        }

        case "exists": {
          return { success: true, data: { exists: existsSync(filePath), path: filePath } };
        }

        case "stat": {
          if (!existsSync(filePath)) {
            return { success: false, data: null, error: `Path not found: ${filePath}` };
          }
          const stats = statSync(filePath);
          return {
            success: true,
            data: {
              path: filePath,
              size: stats.size,
              isDirectory: stats.isDirectory(),
              isFile: stats.isFile(),
              modified: stats.mtime.toISOString(),
              created: stats.birthtime.toISOString(),
            },
          };
        }

        case "move": {
          // Moving a file invalidates any in-flight part sequence for it.
          partGroups.delete(filePath);
          const dest = input["destination"] as string | undefined;
          if (!dest) return { success: false, data: null, error: "Destination required for move" };
          const destPath = resolvePath(dest, {
            basePath: input["basePath"] as string | undefined,
            safeMode,
          });
          const destDir = dirname(destPath);
          if (!existsSync(destDir) && createDirs) mkdirSync(destDir, { recursive: true });
          if (!existsSync(destDir) && !createDirs) {
            return { success: false, data: null, error: `Destination directory does not exist: ${destDir}` };
          }
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, from: filePath, to: destPath } };
          }
          renameSync(filePath, destPath);
          return { success: true, data: { from: filePath, to: destPath } };
        }

        case "copy": {
          const dest = input["destination"] as string | undefined;
          if (!dest) return { success: false, data: null, error: "Destination required for copy" };
          const destPath = resolvePath(dest, {
            basePath: input["basePath"] as string | undefined,
            safeMode,
          });
          const destDir = dirname(destPath);
          if (!existsSync(destDir) && createDirs) mkdirSync(destDir, { recursive: true });
          if (!existsSync(destDir) && !createDirs) {
            return { success: false, data: null, error: `Destination directory does not exist: ${destDir}` };
          }
          // Overwriting the destination invalidates any in-flight part sequence for it.
          partGroups.delete(destPath);
          const copyKind = pathKind(filePath);
          if (copyKind === "missing") {
            return { success: false, data: null, error: `Source file not found: ${filePath}` };
          }
          if (copyKind === "directory") {
            return {
              success: false,
              data: null,
              error: `Cannot copy: '${filePath}' is a directory. Copy individual files, or use the shell tool for a recursive copy.`,
            };
          }
          if (!overwrite && existsSync(destPath)) {
            return { success: false, data: null, error: `Destination already exists: ${destPath}` };
          }
          if (dryRun) {
            return { success: true, data: { dryRun: true, action, from: filePath, to: destPath } };
          }
          copyFileSync(filePath, destPath);
          return { success: true, data: { from: filePath, to: destPath } };
        }

        case "glob": {
          const pattern = input["pattern"] as string | undefined;
          if (!pattern) return { success: false, data: null, error: "pattern required for glob" };
          const maxResults = (input["maxResults"] as number | undefined) ?? 1000;
          const includeIgnored = (input["includeIgnored"] as boolean | undefined) ?? false;
          const matches = globFiles(filePath, pattern, { maxResults, includeIgnored });
          const globScope = displayScopeRoot(input["basePath"] as string | undefined);
          return {
            success: true,
            data: {
              searchedIn: toDisplayPath(filePath, globScope) || ".",
              matches: matches.map((m) => toDisplayPath(m, globScope)),
              count: matches.length,
              truncated: matches.length >= maxResults,
            },
          };
        }

        case "grep": {
          const pattern = input["pattern"] as string | undefined;
          if (!pattern) return { success: false, data: null, error: "pattern required for grep" };
          const filePattern = input["filePattern"] as string | undefined;
          const maxResults = (input["maxResults"] as number | undefined) ?? 500;
          const caseSensitive = (input["caseSensitive"] as boolean | undefined) ?? false;
          const includeIgnored = (input["includeIgnored"] as boolean | undefined) ?? false;
          let matches;
          try {
            matches = grepFiles(filePath, pattern, { filePattern, maxResults, caseSensitive, includeIgnored });
          } catch (grepError) {
            return {
              success: false,
              data: null,
              error: grepError instanceof Error ? grepError.message : String(grepError),
            };
          }
          const grepScope = displayScopeRoot(input["basePath"] as string | undefined);
          return {
            success: true,
            data: {
              searchedIn: toDisplayPath(filePath, grepScope) || ".",
              matches: matches.map((m) => ({ path: toDisplayPath(m.path, grepScope), line: m.line, text: m.text })),
              count: matches.length,
              truncated: matches.length >= maxResults,
            },
          };
        }

        case "outline": {
          const outlineKind = pathKind(filePath);
          if (outlineKind === "missing") {
            return { success: false, data: null, error: `File not found: ${filePath}` };
          }
          if (outlineKind === "directory") {
            return {
              success: false,
              data: null,
              error: `Cannot outline: '${filePath}' is a directory. Use action:"list" for directories.`,
            };
          }
          const outline = outlineFile(filePath);
          return {
            success: true,
            data: {
              path: filePath,
              totalLines: outline.totalLines,
              analyzer: outline.source,
              outline: renderOutline(filePath, outline),
              symbolCount: outline.symbols.length,
              note: `This is the file's SHAPE, not its content. Read the lines you actually need with action:"read" and offset/limit.`,
            },
          };
        }

        default:
          return {
            success: false,
            data: null,
            error: `Unknown action: ${action}. Valid actions: ${FILESYSTEM_ACTIONS.join(", ")}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
