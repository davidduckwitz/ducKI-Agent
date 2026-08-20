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

/**
 * Strip leaked tool-call syntax from a would-be file content. Two conservative
 * passes so real code is never corrupted:
 *   1. Cut everything from the earliest tool-call / stop marker onward (e.g.
 *      "...</body><tool_call|>" -> "...</body>"). Markers never occur in real code.
 *   2. If (and only if) a marker was cut, also remove a trailing run of pure
 *      tool-call wrapper closers ")]" left dangling by the JSON arg wrapper
 *      (e.g. "...</body>'\">])" -> "...</body>'\">"). We touch only ) and ]
 *      (never } or code chars), so balanced code is left intact.
 * A no-op when no marker is present, so it's safe to apply unconditionally to
 * any write/append/edit content field.
 */
export function stripStopMarkers(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  let s = raw;

  let cutIdx = -1;
  for (const m of CONTENT_STOP_MARKERS) {
    const i = s.indexOf(m);
    if (i !== -1 && (cutIdx === -1 || i < cutIdx)) cutIdx = i;
  }
  if (cutIdx === -1) return s;

  s = s.slice(0, cutIdx);
  // Dangling wrapper brackets that the terminator left behind.
  s = s.replace(/["'`,\s]*[)\]][)\]"'`,\s]*$/, "");
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
  return raw.replace(/["'`]\s*\}\s*\)?\s*\]?\s*$/, "");
}
