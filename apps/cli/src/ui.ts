import type { AgentRunEvent } from "@ducki/agent";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const GRAY = "\x1b[90m";

const useColor = process.stdout.isTTY;
const c = (code: string, text: string): string => (useColor ? `${code}${text}${RESET}` : text);

export function box(title: string, subtitle?: string): string {
  const innerWidth = Math.max(title.length, subtitle?.length ?? 0) + 2;
  const border = (text: string): string => (useColor ? `${CYAN}${text}${RESET}` : text);
  const row = (text: string, style: string): string => {
    const padded = ` ${text.padEnd(innerWidth - 1)}`;
    const styled = useColor ? `${style}${padded}${RESET}` : padded;
    return `${border("│")}${styled}${border("│")}`;
  };

  const lines = [
    border(`╭${"─".repeat(innerWidth)}╮`),
    row(title, BOLD),
  ];
  if (subtitle) lines.push(row(subtitle, DIM));
  lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
  return lines.join("\n");
}

/**
 * One compact, colored line per agent event - the modern-CLI counterpart to Hermes'
 * single-line tool-completion summaries. Event `message` strings are already
 * human-readable (built by Agent's own emit() calls), so this only adds an icon/color
 * per event type instead of dumping raw event objects. "assistant_text"/"iteration" are
 * skipped: the former duplicates the streamed response, the latter is a bare counter.
 */
export function renderEvent(event: AgentRunEvent): string | undefined {
  switch (event.type) {
    case "tool_call":
      return c(CYAN, `  → ${event.message}`);
    case "tool_result": {
      const success = event.data?.["success"] !== false;
      return success ? c(GREEN, `  ✓ ${event.message}`) : c(RED, `  ✗ ${event.message}`);
    }
    case "plan":
      return c(BLUE, `  ▤ ${event.message}`);
    case "checklist":
      return c(BLUE, `  ☑ ${event.message}`);
    case "guardrail":
      return c(YELLOW, `  ⚠ ${event.message}`);
    case "browser_preview":
      return c(CYAN, `  ◈ ${event.message}`);
    case "decision":
    case "reasoning":
    case "mode_selected":
      return c(GRAY, `  · ${event.message}`);
    default:
      return undefined;
  }
}

export function promptLabel(): string {
  return c(GREEN, "Du: ");
}

export function responseLabel(): string {
  return c(YELLOW, "DucKI: ");
}

export function errorLine(message: string): string {
  return c(RED, `Fehler: ${message}`);
}

export function dim(text: string): string {
  return c(DIM, text);
}

const SPINNER_LINE_WIDTH = 24;

/**
 * A classic rotating "|/-\" spinner plus elapsed seconds, redrawn in place on one line via
 * `\r` - fills the gap between submitting a question and the first response token. `clear()`
 * blanks the line so other output (an event line from onEvent, the response label) can print
 * cleanly above/instead of it; the running interval simply redraws on the next tick, so no
 * explicit "resume" call is needed after a clear() that isn't immediately followed by stop().
 */
export class Spinner {
  private static readonly FRAMES = ["|", "/", "-", "\\"];
  private timer: NodeJS.Timeout | undefined;
  private frameIndex = 0;
  private startTime = 0;

  get isActive(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (!useColor) return; // non-TTY output (piped/redirected): an animated line is just noise
    this.startTime = Date.now();
    this.frameIndex = 0;
    this.render();
    this.timer = setInterval(() => this.render(), 120);
  }

  private render(): void {
    const elapsedSeconds = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const frame = Spinner.FRAMES[this.frameIndex % Spinner.FRAMES.length];
    this.frameIndex++;
    process.stdout.write(`\r${c(CYAN, frame!)} ${dim(`${elapsedSeconds}s`)}`);
  }

  clear(): void {
    if (!useColor) return;
    process.stdout.write(`\r${" ".repeat(SPINNER_LINE_WIDTH)}\r`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clear();
  }
}

/**
 * Local models occasionally emit literal two-character `\n`/`\t`/`\r` escape sequences in
 * prose responses (as if writing a JSON string) instead of real control characters - the
 * same class of leak `packages/tools/src/filesystem.ts` already unescapes for file content.
 * Chat responses never went through that step, so they printed as literal backslash-n text.
 */
function unescapeLiteralSequences(text: string): string {
  return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
}

/** Lightweight, best-effort markdown-to-ANSI for one complete line: bold, inline code, blockquotes, headings. */
function styleMarkdownLine(line: string): string {
  if (!useColor) return line;

  const blockquote = /^>\s?(.*)$/.exec(line);
  if (blockquote) return `${DIM}│ ${blockquote[1]}${RESET}`;

  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return `${BOLD}${CYAN}${heading[2]}${RESET}`;

  return line
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`)
    .replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`);
}

/**
 * Buffers streamed chunks into complete lines before printing, so unescaping and markdown
 * styling (both of which need a whole line/marker-pair to work correctly) can't be corrupted
 * by an arbitrary mid-sequence chunk boundary. A trailing partial line is held back and only
 * flushed once a newline completes it or flush() is called at the end of the stream - in
 * practice this still reads as live streaming, since most lines complete within a token or
 * two of chunks, just like `glow`/`mdcat`-style markdown-aware terminal renderers.
 */
export class StreamRenderer {
  private buffer = "";
  // Tracks whether the LAST thing actually written to stdout ended in a newline - not
  // whether `buffer` is empty, since buffered-but-unflushed text hasn't reached the
  // terminal yet and so can't have moved the cursor. Defaults to false: a renderer is
  // always constructed right after printing a response label ("DucKI: ") with no newline.
  private cursorAtLineStart = false;

  /** True if the terminal cursor is at the start of a fresh line (safe to print onto directly). */
  get atLineStart(): boolean {
    return this.cursorAtLineStart;
  }

  write(rawChunk: string): void {
    this.buffer += rawChunk;

    // Hold back a lone trailing backslash - it may be the start of an escape sequence split
    // across this chunk boundary and the next one.
    let pending = this.buffer;
    const heldBackslash = pending.endsWith("\\") && !pending.endsWith("\\\\");
    if (heldBackslash) pending = pending.slice(0, -1);

    const unescaped = unescapeLiteralSequences(pending);
    const lines = unescaped.split("\n");
    const trailing = lines.pop() ?? "";

    for (const line of lines) {
      process.stdout.write(styleMarkdownLine(line) + "\n");
      this.cursorAtLineStart = true;
    }
    this.buffer = trailing + (heldBackslash ? "\\" : "");
  }

  /** Emits whatever partial line is still buffered - call once the stream ends. */
  flush(): void {
    if (this.buffer.length === 0) return;
    process.stdout.write(styleMarkdownLine(unescapeLiteralSequences(this.buffer)));
    this.cursorAtLineStart = false;
    this.buffer = "";
  }
}
