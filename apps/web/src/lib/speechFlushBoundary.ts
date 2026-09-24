/** Chatterbox renders whole utterances: avoid repeatedly paying generation overhead for
 * 40-character fragments. Keep the first phrase shorter and preserve unfinished words. */
export function speechFlushBoundary(text: string, first: boolean, chatterbox: boolean): number {
  const limit = chatterbox ? (first ? 100 : 220) : 40;
  const sentence = /[.!?]["')\]]*\s+|\n+/.exec(text);
  if (sentence && (!chatterbox || sentence.index < limit)) return sentence.index + sentence[0].length;
  if (chatterbox) {
    const clause = /[,;:]\s+/g;
    for (const match of text.matchAll(clause)) {
      if (match.index >= (first ? 40 : 100) && match.index < limit) return match.index + match[0].length;
    }
  }
  if (text.length < limit) return 0;
  const boundary = text.lastIndexOf(" ", limit);
  // A long word remains buffered until a boundary or the end of the turn.
  return boundary > 0 ? boundary + 1 : 0;
}
