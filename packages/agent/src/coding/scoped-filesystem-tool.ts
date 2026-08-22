import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { filesystemTool, stripStopMarkers, stripTrailingJsonArgTail } from "@ducki/tools";

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
  // project dir), longest match first, down to a single segment.
  //
  // This used to require at least 2 segments, on the theory that a project slug matching
  // an ordinary subfolder name (e.g. a real project here is literally called "js") could
  // be mistaken for a repeated sandbox prefix and misplace a genuine "js/utils.js"
  // subfolder. That theory undersold the cost of NOT stripping: every coding sandbox is
  // exactly `CODING_WORKSPACE_ROOT/<project-slug>` - ONE segment - so the single-segment
  // case this used to skip is the COMMON case, not the rare one, and a model that repeats
  // its own project slug as a leading path segment (which it does constantly, having just
  // seen that slug in its own prompt) got silently nested one directory level too deep -
  // a same-session `read("index.html")` at the path the model actually believes is
  // correct then fails with "File not found". Write and read silently disagreeing on
  // where the file lives is far worse than the rare false-positive strip of a
  // genuinely-intended same-named subfolder.
  for (let take = Math.min(sbSegs.length, pSegs.length); take >= 1; take--) {
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
 * Strip leaked tool-call syntax from a would-be file content. Two conservative
 * passes so real code is never corrupted, then a sandbox-specific pass that's
 * only safe for text-protocol content (see stripTrailingJsonArgTail's doc):
 *   1. stripStopMarkers cuts everything from the earliest tool-call / stop
 *      marker onward, plus a trailing run of dangling wrapper closers ")]".
 *   2. stripTrailingJsonArgTail additionally removes a quote-led arg-wrapper
 *      tail like "})", "})]" or "}]" even when no marker was found - real
 *      source files effectively never end in that exact punctuation run, but
 *      a native/heredoc call's verbatim content legitimately could (e.g. JSON
 *      ending in `"}`), which is why this step isn't in the shared base.
 */
export function sanitizeCodeContent(raw: unknown): unknown {
  return stripTrailingJsonArgTail(stripStopMarkers(raw));
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
      // Skip sanitizing for trusted sources. The flag itself is left on scopedInput (rather
      // than deleted here) so filesystemTool.execute can also see it and skip its own \n\t\r
      // de-escape, which would otherwise corrupt verbatim content the same way sanitizing
      // would - filesystemTool deletes the flag itself before it could leak any further.
      const contentTrusted = scopedInput["__contentTrusted"] === true;
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
