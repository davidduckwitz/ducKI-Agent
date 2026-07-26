const MAX_TITLE_LENGTH = 60;
const MIN_BREAK_POINT = 20;

/** Derives a short conversation title from a user's first message, truncating at a word
 *  boundary. Falls back to a timestamp label when the message has no usable text (e.g. an
 *  attachment-only message). */
export function deriveConversationTitle(message: string): string {
  const normalized = message.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return `Conversation ${new Date().toLocaleString()}`;
  }

  if (normalized.length <= MAX_TITLE_LENGTH) {
    return normalized;
  }

  const truncated = normalized.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > MIN_BREAK_POINT ? truncated.slice(0, lastSpace) : truncated;
  return `${cut}…`;
}
