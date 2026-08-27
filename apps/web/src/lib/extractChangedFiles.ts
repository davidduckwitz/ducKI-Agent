/**
 * Extract the file paths a message's tool calls changed (write/edit/create/…).
 *
 * Heuristic but robust: the path sits near the front of a filesystem tool marker,
 * before any large content payload, so we only scan the marker's head — avoiding
 * brittle full-JSON parsing of code that itself contains ")]". Shared by the coding
 * chat (file chips) and the workspace (auto-open the written file).
 */
export function extractChangedFiles(content: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const markerRe = /\[TOOL:\s*([a-z_]+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(content)) !== null) {
    const tool = (m[1] ?? "").toLowerCase();
    if (!/(filesystem|file|write|edit|coding)/.test(tool)) continue;
    const head = content.slice(m.index, m.index + 400);
    const action = head.match(/"action"\s*:\s*"([^"]+)"/)?.[1]?.toLowerCase();
    const path = head.match(/"(?:path|file_path|filePath)"\s*:\s*"([^"]+)"/)?.[1];
    const isWrite = !action || /write|create|edit|replace|insert|append|patch/.test(action);
    if (path && isWrite && !seen.has(path)) {
      seen.add(path);
      files.push(path);
    }
  }
  return files;
}

/** Cuts a raw assistant message off at its first tool-call marker, leaving only the prose the
 *  model actually said - the marker's own JSON/args are machine-facing, not something to show
 *  as a human-readable summary. Shared by the coding chat and the plan completion summary. */
export function stripToolMarkers(text: string): string {
  let out = text;
  for (const marker of ["[TOOL:", "<|tool_call>", "<tool_call>"]) {
    const idx = out.indexOf(marker);
    if (idx >= 0) out = out.slice(0, idx);
  }
  return out.trim();
}
