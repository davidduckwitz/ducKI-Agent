/**
 * Tool-call / stop-token markers that a weak local model sometimes emits INSIDE
 * a file-content string when it mangles the closing quote of a write call.
 * Shared between the plain filesystem tool and the CodingAgent sandbox wrapper
 * so both write paths get the same protection against leaked tool-call syntax.
 */
export const CONTENT_STOP_MARKERS = [
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

/** Only wrapper punctuation - what a spilled terminator leaves behind it. */
const WRAPPER_JUNK_ONLY = /^[\s"'`,;:)\]}]*$/;

/** A leaked tool CALL continues with a tool name followed by its argument opener. */
const LEAKED_CALL_CONTINUATION = /^\s*[A-Za-z_][\w-]*\s*[({]/;

/**
 * Whether the text following a marker means the marker is a leaked terminator rather than
 * prose that merely mentions the syntax.
 *
 * Length is the wrong test (a short document mentioning `[TOOL:` looks exactly like a long one
 * to a character budget). What separates the two is what comes AFTER: a spilled terminator is
 * followed by nothing but wrapper punctuation, or by the rest of a tool call - never by
 * sentences.
 */
function looksLikeLeakedTerminator(tail: string): boolean {
  return WRAPPER_JUNK_ONLY.test(tail) || LEAKED_CALL_CONTINUATION.test(tail);
}

/**
 * Strip leaked tool-call syntax from a would-be file content.
 *
 * The original claim behind this was "markers never occur in real code". That is false for the
 * one kind of file this agent writes about itself: documentation. A file explaining the tool
 * format legitimately contains `[TOOL:` and `[/TOOL]`, and cutting from the first occurrence
 * silently truncated the document at that sentence - or, when the marker appeared near the very
 * start, reduced the content to an empty string, which the write path then reported as the
 * baffling "Content required for write" for a call that plainly carried content.
 *
 * Two guards keep the leak protection while removing that failure mode:
 *   1. Only cut when what FOLLOWS the marker marks it as a spilled terminator - wrapper
 *      punctuation, or the remainder of a leaked tool call - never running prose.
 *   2. Never cut everything. If stripping would empty the content, the marker WAS the content -
 *      that is not the leak pattern, and returning "" loses the file entirely.
 *
 * Then, as before: if a marker was cut, also remove the trailing run of pure wrapper closers
 * ")]" the JSON arg wrapper left dangling. Only ) and ] are touched (never } or code chars).
 */
export function stripStopMarkers(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const original = raw;

  let cutIdx = -1;
  for (const m of CONTENT_STOP_MARKERS) {
    const i = original.indexOf(m);
    if (i === -1) continue;
    // Guard 1: a marker followed by real prose is documentation about the syntax, not a leak.
    if (!looksLikeLeakedTerminator(original.slice(i + m.length))) continue;
    if (cutIdx === -1 || i < cutIdx) cutIdx = i;
  }
  if (cutIdx === -1) return original;

  let s = original.slice(0, cutIdx);
  // Dangling wrapper brackets that the terminator left behind.
  s = s.replace(/["'`,\s]*[)\]][)\]"'`,\s]*$/, "");

  // Guard 2: stripping must never consume the whole file.
  if (s.trim().length === 0) return original;
  return s;
}

/**
 * Strips a quote-led JSON arg-wrapper tail: `"` closing the content string, then
 * the `}` closing the args object and `)`/`]` closing the call (e.g. `"})`,
 * `"})]`, `"}]`). Applied unconditionally (whether or not a stop marker was
 * seen), which is only safe for content known to come through a text-protocol
 * write where such a tail can never be legitimate file content - a native/
 * heredoc tool call delivers content verbatim and could legitimately end in
 * `"}` (e.g. a JSON file). Kept sandbox-specific rather than folded into
 * stripStopMarkers for that reason.
 */
export function stripTrailingJsonArgTail(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;

  // Content that is already valid JSON is never a mangled arg tail - it is a JSON file, and
  // `{"name":"x"}` ends in exactly the `"}` this pattern hunts for. Stripping it produced
  // `{"name":"x`, which the write path then rejected as invalid JSON: a corrupted file
  // narrowly avoided, but a write that could not succeed no matter how often it was retried.
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return raw;
    } catch {
      // Not valid JSON - fall through and treat the tail as the wrapper leak it looks like.
    }
  }

  const stripped = raw.replace(/["'`]\s*\}\s*\)?\s*\]?\s*$/, "");
  // Never let the heuristic consume the whole content.
  return stripped.trim().length === 0 ? raw : stripped;
}
