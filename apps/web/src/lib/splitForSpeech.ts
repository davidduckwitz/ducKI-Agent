// Sentence end (. ! ?, optionally followed by a closing quote/bracket, then whitespace) or a
// paragraph break - matches what a listener would perceive as "a sentence just finished".
const SENTENCE_BREAK_RE = /[.!?]["')\]]*\s+|\n+/g;

// Soft cap on how much text a single TTS request carries. Every non-streaming call ends up as
// one HTTP POST to /api/chat/speak with the whole string as `text` (see playServerAudio in
// useSpeechSynthesis.ts).
//
// The REAL hard limit lives server-side now, not here: Chatterbox's T3 model only supports
// hp.max_text_tokens (2048) text tokens - exceeding it used to crash CUDA with a device-side
// assertion rather than fail cleanly. apps/server/scripts/chatterbox_server.py's
// validate_text_length() now checks the actual tokenizer output before calling generate() and
// returns a normal 400 instead, so an oversized chunk from here is safely rejected (and can be
// retried smaller) rather than crashing the server.
//
// Token density varies a lot by language - measured ~1.4 chars/token for German (so the model's
// real ceiling is roughly 2850 German characters), but CJK languages tokenize far denser per
// character, so no single character constant here is "optimal" for all 23 supported languages
// at once. This value targets the common case (the app's own default/tested languages are
// Latin-script) with headroom under that ~2850 measurement, while the server-side token check
// is what actually guarantees correctness for every language, including ones far denser than
// German. Push this value up if you confirm your primary usage language tokenizes similarly to
// or more sparsely than German; leave it conservative if you regularly use a denser language.
export const MAX_SPEECH_CHUNK_CHARS = 2500;

/**
 * Splits a block of text that may span multiple sentences/paragraphs into pieces no larger than
 * MAX_SPEECH_CHUNK_CHARS, so a single oversized text (a long streamed reply, or a full message
 * replayed via a manual "read aloud" click) becomes several reasonably-sized TTS requests
 * instead of one a server provider will reject outright.
 *
 * First splits on sentence/paragraph boundaries (so each piece is a natural completed thought
 * wherever possible), then, only if an individual sentence is itself still over the cap (a long
 * run-on with no internal punctuation), falls back to cutting at the nearest preceding
 * whitespace so no piece ever exceeds the cap.
 *
 * Shared by useStreamingSpeech.ts (live streaming flush) and useSpeechSynthesis.ts (manual
 * speak()/replay of an already-complete message) - both paths independently hand a server TTS
 * provider a single string, so both need the same size guard.
 */
export function splitForSpeech(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences: string[] = [];
  let cursor = 0;
  SENTENCE_BREAK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_BREAK_RE.exec(trimmed))) {
    const end = match.index + match[0].length;
    const piece = trimmed.slice(cursor, end).trim();
    if (piece) sentences.push(piece);
    cursor = end;
  }
  const tail = trimmed.slice(cursor).trim();
  if (tail) sentences.push(tail);

  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= MAX_SPEECH_CHUNK_CHARS) {
      pieces.push(sentence);
      continue;
    }
    let remaining = sentence;
    while (remaining.length > MAX_SPEECH_CHUNK_CHARS) {
      let cut = remaining.lastIndexOf(" ", MAX_SPEECH_CHUNK_CHARS);
      if (cut <= 0) cut = MAX_SPEECH_CHUNK_CHARS; // no whitespace to break on - cut hard rather than never
      pieces.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) pieces.push(remaining);
  }
  return pieces;
}
