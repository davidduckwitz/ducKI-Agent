/**
 * Text vs. binary for the file viewers/editors (/api/coding and /api/shared read routes).
 * Known binary formats are always binary; everything else - PHP, Markdown, shell, configs, files
 * without an extension - is text when its content sniffs as text.
 */

/** Extensions that are always binary, even though they'd sniff as text (e.g. a
 *  well-formed SVG, which the UI shows as an image). */
const ALWAYS_BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".mp4", ".webm", ".mov", ".avi", ".mp3", ".wav", ".ogg",
  ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".exe", ".dll", ".bin", ".db", ".sqlite",
]);

/** Sniffs a buffer for text vs. binary the way `file`/git do: a NUL byte anywhere
 *  in the sample is a reliable binary signal, and near-real text almost never
 *  contains other control bytes below 0x09. */
function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious++;
  }
  return sample.length === 0 || suspicious / sample.length < 0.02;
}

/** `ext` lower-cased with leading dot, as returned by path.extname(). */
export function isTextFile(ext: string, buffer: Buffer): boolean {
  return !ALWAYS_BINARY_EXTENSIONS.has(ext) && looksLikeText(buffer);
}
