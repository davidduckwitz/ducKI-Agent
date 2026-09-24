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

/**
 * A leaked tool CALL continues with a tool name followed by its arguments - either the JSON
 * form's opening bracket (`filesystem({…`) or the block form's key=value pairs
 * (`todo action=update id=1`). Both shapes were observed leaking into written files.
 *
 * Prose that merely mentions the syntax does not look like this: "[TOOL:filesystem] um zu
 * schreiben" has the closing bracket straight after the name, never an argument.
 */
const LEAKED_CALL_CONTINUATION = /^\s*[A-Za-z_][\w-]*(?:\s*[({]|\s+[A-Za-z_][\w-]*\s*=)/;

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

/**
 * A leaked tool-call ATTEMPT opens with a call-shaped wrapper around dict/JSON-like
 * key-value pairs naming a tool-call argument this app's own tools use (`action`, `path`,
 * `tool`, `name`, `command`) - e.g. `({'action': 'write', 'path': '...', 'content': '...'})`.
 * Python-dict-style single-quoted keys are tolerated alongside JSON's double quotes, since the
 * observed leaks came from models imitating a Python/Hermes-ish tool-call convention rather
 * than this app's own `[TOOL:name({"key": "value"})]` format.
 *
 * Deliberately narrow: requires a wrapper character immediately followed by an object literal
 * whose FIRST key is one of that fixed list - not "any text that happens to start with a
 * parenthesis or brace" - so genuine prose (including prose that discusses tool-call syntax)
 * does not trip it.
 */
const LEAKED_TOOLCALL_OPEN_RE = /^[[(]?\s*\{\s*['"](action|tool|tool_name|toolName|name|command|path)['"]\s*:\s*['"]/;

/**
 * A leaked tool-call attempt's trailing junk: a stray closing wrapper optionally followed by a
 * mangled stop-token-ish marker such as `< toolcall_end` (note: real stop tokens are usually
 * `<tool_call_end>`/`</tool_call>` with no inner space and a closing `>` - this leak's own
 * marker was missing both, which is exactly the kind of one-off mangling that makes it
 * unrecognisable as any single known convention; matched loosely here since only the LEADING
 * shape above needs to be confident, this is just corroborating evidence).
 */
const LEAKED_TOOLCALL_TRAILING_RE = /[)\]}]\s*<\s*\/?\s*[a-z_]*tool[_\s]?call[_\s]?(end|stop)?\s*>?\s*$/i;

/**
 * Whether a full response/message text looks like a leaked, malformed tool-call attempt rather
 * than genuine prose - the shape observed leaking straight into a visible chat reply (see the
 * write-tool-shaped example above). Two independent signals, either one sufficient given how
 * narrow LEAKED_TOOLCALL_OPEN_RE already is on its own:
 *   - the text opens exactly like a serialized tool call (LEAKED_TOOLCALL_OPEN_RE), or
 *   - the text ends with the kind of stray closer + mangled stop-marker a spilled call leaves
 *     behind (LEAKED_TOOLCALL_TRAILING_RE) AND still opens with a wrapper character, ruling out
 *     prose that merely happens to end with "...)".
 *
 * Kept intentionally conservative (mirrors looksLikeLeakedTerminator's discriminator above): a
 * false positive here would hide a legitimate reply, which is worse than leaving a rare leak
 * visible.
 */
export function looksLikeLeakedToolCallAttempt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (LEAKED_TOOLCALL_OPEN_RE.test(trimmed)) return true;
  if (/^[[({]/.test(trimmed) && LEAKED_TOOLCALL_TRAILING_RE.test(trimmed)) return true;
  return false;
}
