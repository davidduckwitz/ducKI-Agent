import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { filesystemTool } from "@ducki/tools";

const toSegments = (p: string): string[] =>
  p.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);

/**
 * The path is resolved relative to sandboxRoot, so a model that (re)includes the
 * sandbox in its path doubles it — e.g. path "coding/<project>/index.html" against
 * a sandbox already at ".../coding/<project>" yields ".../coding/<project>/coding/
 * <project>/index.html". Strip a redundant leading prefix: an absolute path inside
 * the sandbox, or any leading run of segments matching the tail of the sandbox
 * (handles "shared-workspace/coding/<project>/", "coding/<project>/", "<project>/").
 * A genuinely-relative path (e.g. "src/app.js") is left untouched.
 */
export function normalizeScopedPath(rawPath: string, sandboxRoot: string): string {
  const original = String(rawPath ?? "").trim();
  if (!original) return original;

  const sbSegs = toSegments(sandboxRoot);
  const pSegs = toSegments(original);
  if (pSegs.length === 0) return original;

  const lc = (segs: string[]) => segs.map((s) => s.toLowerCase());
  const sbLc = lc(sbSegs);
  const pLc = lc(pSegs);

  // Absolute path that lands inside the sandbox → make it relative.
  if (pLc.length >= sbLc.length && sbLc.every((s, i) => s === pLc[i])) {
    const rest = pSegs.slice(sbLc.length).join("/");
    return rest || ".";
  }

  // Leading run of segments equal to the SANDBOX TAIL (which always ends in the
  // project dir), longest match first. Requires at least 2 segments so a project
  // slug that happens to match an ordinary subfolder name (e.g. a real project here
  // is literally called "js") is never mistaken for a repeated sandbox prefix -
  // stripping "js/utils.js" down to "utils.js" would silently misplace a file the
  // model genuinely meant to put in a js/ subfolder, with no error to signal it. A
  // bare repeated project name (single segment, e.g. "js/utils.js" meant as the
  // redundant-prefix case) is left alone; worst case it lands one harmless
  // directory level deeper instead of being silently discarded.
  for (let take = Math.min(sbSegs.length, pSegs.length); take >= 2; take--) {
    const sbSuffix = sbLc.slice(sbLc.length - take).join("/");
    const pPrefix = pLc.slice(0, take).join("/");
    if (sbSuffix === pPrefix) {
      const rest = pSegs.slice(take).join("/");
      return rest || ".";
    }
  }

  return original;
}

/**
 * Tool-call / stop-token markers that a weak local model sometimes emits INSIDE
 * the file-content string when it mangles the closing quote of the write call.
 * We cut the content at the earliest such marker so it never lands in the file.
 */
const CONTENT_STOP_MARKERS = [
  "<|tool_call>",
  "<tool_call|>",
  "<|tool_call|>",
  "</tool_call>",
  "<tool_call>",
  "<|tool_call_start|>",
  "<|tool_call_end|>",
  "[/TOOL]",
  "[TOOL:",
  "<|im_end|>",
  "<|im_start|>",
  "<end_of_turn>",
  "<start_of_turn>",
  "<|endoftext|>",
  "<|eot_id|>",
];

/**
 * Strip leaked tool-call syntax from a would-be file content. Two conservative
 * passes so real code is never corrupted:
 *   1. Cut everything from the earliest tool-call / stop marker onward (e.g.
 *      "...</body><tool_call|>" -> "...</body>"). Markers never occur in real code.
 *   2. If (and only if) a marker was cut, also remove a trailing run of pure
 *      tool-call wrapper closers ")]" left dangling by the JSON arg wrapper
 *      (e.g. "...</body>'\">])" -> "...</body>'\">"). We touch only ) and ]
 *      (never } or code chars), so balanced code is left intact.
 * Additionally, a quote-led arg-wrapper tail like "})", "})]" or "}]" at the very
 * end (the '"' + '}' + ')' that closes the JSON string+object+call) is stripped,
 * since real source files effectively never end in that exact punctuation run.
 */
export function sanitizeCodeContent(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  let s = raw;

  let cutIdx = -1;
  for (const m of CONTENT_STOP_MARKERS) {
    const i = s.indexOf(m);
    if (i !== -1 && (cutIdx === -1 || i < cutIdx)) cutIdx = i;
  }
  const markerCut = cutIdx !== -1;
  if (markerCut) s = s.slice(0, cutIdx);

  if (markerCut) {
    // Dangling wrapper brackets that the terminator left behind.
    s = s.replace(/["'`,\s]*[)\]][)\]"'`,\s]*$/, "");
  }

  // Quote-led JSON arg-wrapper tail: `"` closing the content string, then the
  // `}` closing the args object and `)`/`]` closing the call. Real files don't
  // end in `"})` / `"})]` / `"}]`, so this is safe to strip whether or not a
  // marker was seen.
  s = s.replace(/["'`]\s*\}\s*\)?\s*\]?\s*$/, "");

  return s;
}

/**
 * filesystemTool's own JSON-schema `definition` - what the model actually reads to decide how to
 * call the tool, especially under native function-calling - hardcodes shared-workspace framing
 * ("All paths are scoped to shared-workspace for safety.", the first path example being
 * "/shared-workspace/config.json", "use this for paths like ./shared-workspace"). That text is
 * correct for the UNSCOPED tool (regular chat), but actively misleads a sandboxed CodingAgent
 * into constructing shared-workspace-shaped paths even though it's confined to a completely
 * different sandbox - the top-level `description` string got a "(scoped to ...)" suffix already,
 * but these nested schema strings did not, so the model kept seeing the old guidance. Deep-clones
 * the definition (plain JSON-schema data, safe to structurally clone) and rewrites just the
 * misleading strings, leaving every other field (action enum, all other parameter docs) intact.
 */
function scopedFilesystemDefinition(sandboxRoot: string): typeof filesystemTool.definition {
  const cloned = JSON.parse(JSON.stringify(filesystemTool.definition)) as typeof filesystemTool.definition;
  cloned.description = `File system operations, scoped to ${sandboxRoot}. Required parameters: action (the operation), path (file/directory path, RELATIVE to the sandbox root - never shared-workspace). Directories and files take different actions: list/mkdir operate on directories, read/write/append/edit/copy operate on files.`;
  const properties = cloned.parameters?.properties as Record<string, { description?: string }> | undefined;
  if (properties?.["path"]) {
    properties["path"].description =
      `REQUIRED: File or directory path RELATIVE to the sandbox root (${sandboxRoot}). Examples: config.json, ./data/file.txt, data/subfolder/. NEVER prefix with shared-workspace, coding/, an absolute path, or the sandbox path itself. A path without a file extension is usually a directory - use action:'list' for it.`;
  }
  if (properties?.["action"]) {
    properties["action"].description = String(properties["action"].description ?? "").replace(
      /use this for paths like \.\/shared-workspace/i,
      "use this for a directory path relative to the sandbox root"
    );
  }
  return cloned;
}

/**
 * Wraps the generic filesystem tool so a CodingAgent confined to a sandbox
 * (e.g. shared-workspace/coding/<project>) is hard-locked to that root.
 * basePath and safeMode are always forced here, overriding whatever the LLM
 * supplies in its own tool call - otherwise the model could pass its own
 * basePath or safeMode:false and escape the sandbox entirely. Path fields are
 * de-duplicated (see normalizeScopedPath) so a model that repeats the sandbox
 * prefix doesn't double it.
 */
export function createScopedFilesystemTool(sandboxRoot: string): ToolExecutor {
  return {
    name: filesystemTool.name,
    description: `${filesystemTool.description} (scoped to ${sandboxRoot})`,
    definition: scopedFilesystemDefinition(sandboxRoot),
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const scopedInput: Record<string, unknown> = { ...input, basePath: sandboxRoot, safeMode: true };
      // Calls that came from a NATIVE tool_call or the heredoc write block deliver content
      // verbatim - there is no JSON-string wrapper for tool-call syntax to leak into, so
      // sanitizeCodeContent's heuristics (especially the unconditional trailing `"}` strip)
      // can only do harm here, e.g. truncating a JSON file that legitimately ends in `"}`.
      // Skip sanitizing for trusted sources; always drop the internal flag before forwarding.
      const contentTrusted = scopedInput["__contentTrusted"] === true;
      delete scopedInput["__contentTrusted"];
      for (const field of ["path", "file_path", "filePath", "oldPath", "newPath", "source", "destination", "dest"]) {
        if (typeof scopedInput[field] === "string") {
          scopedInput[field] = normalizeScopedPath(scopedInput[field] as string, sandboxRoot);
        }
      }
      // Strip leaked tool-call / stop-token junk out of would-be file content (text protocol only).
      if (!contentTrusted) {
        for (const field of ["content", "contents", "text", "file_text", "fileText", "fileContent", "file_contents", "data", "body"]) {
          if (typeof scopedInput[field] === "string") {
            scopedInput[field] = sanitizeCodeContent(scopedInput[field]);
          }
        }
      }
      return filesystemTool.execute(scopedInput);
    },
  };
}
