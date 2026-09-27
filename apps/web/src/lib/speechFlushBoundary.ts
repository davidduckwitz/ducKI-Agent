// Chatterbox renders whole utterances (T3 has no incremental text input) and each request pays a
// fixed generation overhead, so every mid-sentence cut produces an audible pause plus a prosody
// reset. The server-side ceiling is ~2048 text tokens (~2800 German chars, see splitForSpeech.ts),
// so these caps are nowhere near the model limit - they only bound time-to-first-audio.
// FIRST_MAX: longest first chunk before we give up waiting for a sentence end.
// NEXT_MAX: later chunks - whole sentences are batched up to this size (playback of the previous
// chunk covers the generation time), and only a single sentence longer than this gets cut.
const CHATTERBOX_FIRST_MAX = 300;
const CHATTERBOX_NEXT_MAX = 700;
const SENTENCE_END_RE = /[.!?]["')\]]*\s+|\n+/g;

/** Returns how many chars of `text` to flush to TTS now (0 = keep buffering). */
export function speechFlushBoundary(text: string, first: boolean, chatterbox: boolean): number {
  if (!chatterbox) {
    const limit = 40;
    const sentence = /[.!?]["')\]]*\s+|\n+/.exec(text);
    if (sentence) return sentence.index + sentence[0].length;
    if (text.length < limit) return 0;
    const boundary = text.lastIndexOf(" ", limit);
    return boundary > 0 ? boundary + 1 : 0;
  }

  const limit = first ? CHATTERBOX_FIRST_MAX : CHATTERBOX_NEXT_MAX;
  // Latest complete sentence end within the cap. The first chunk flushes at the first sentence
  // end (fast start); later chunks batch as many whole sentences as fit.
  let sentenceEnd = 0;
  for (const match of text.matchAll(SENTENCE_END_RE)) {
    const end = match.index + match[0].length;
    if (end > limit) break;
    sentenceEnd = end;
    if (first) break;
  }
  if (sentenceEnd > 0) return sentenceEnd;
  // No sentence end yet: keep waiting until the cap, then fall back to a clause, then a space.
  if (text.length < limit) return 0;
  let clauseEnd = 0;
  for (const match of text.matchAll(/[,;:]\s+/g)) {
    const end = match.index + match[0].length;
    if (end > limit) break;
    clauseEnd = end;
  }
  if (clauseEnd >= limit / 2) return clauseEnd;
  const boundary = text.lastIndexOf(" ", limit);
  // A long word remains buffered until a boundary or the end of the turn.
  return boundary > 0 ? boundary + 1 : 0;
}
