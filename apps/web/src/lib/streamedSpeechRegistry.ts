/**
 * Bridges the two auto-speak paths in TTS streaming mode:
 *  - useStreamingSpeech (StreamingRow) speaks text while it streams in via chat:chunk and
 *    records here what it covered once a block closes.
 *  - VoicePlayback (MessageRow) is the committed message. In streaming mode it used to stay
 *    silent unconditionally, assuming the streaming path already spoke it - but a block can
 *    reach the transcript with no (or only partial) chunk stream: non-streaming provider
 *    iterations, a final chat:complete without a display row, a chunk tail that never arrived.
 *    Those replies showed up as text but were never spoken ("sometimes I have to press play").
 *    VoicePlayback now asks this registry what is still unspoken and speaks only that.
 */

interface StreamedEntry {
  text: string;
  at: number;
}

const MAX_AGE_MS = 5 * 60_000;
const entries: StreamedEntry[] = [];
let replyInterrupted = false;

const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

export function recordStreamedSpeech(text: string): void {
  const normalized = normalize(text);
  if (!normalized) return;
  entries.push({ text: normalized, at: Date.now() });
  if (entries.length > 20) entries.splice(0, entries.length - 20);
}

/**
 * Returns the part of `content` the streaming path has NOT spoken (the whole text when no
 * streamed block matches, "" when it was fully covered). A matched entry is consumed so a later
 * identical message is judged on its own.
 */
export function takeUnstreamedRemainder(content: string): string {
  const now = Date.now();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (now - entries[i]!.at > MAX_AGE_MS) entries.splice(i, 1);
  }
  const target = normalize(content);
  if (!target) return "";
  for (let i = entries.length - 1; i >= 0; i--) {
    const streamed = entries[i]!.text;
    if (streamed.startsWith(target)) {
      entries.splice(i, 1);
      return "";
    }
    if (target.startsWith(streamed)) {
      entries.splice(i, 1);
      return target.slice(streamed.length).trim();
    }
  }
  return target;
}

export function setReplyInterrupted(value: boolean): void {
  replyInterrupted = value;
}

export function isReplyInterrupted(): boolean {
  return replyInterrupted;
}
