import { tokenizeText } from "@ducki/shared";

/**
 * Jaccard similarity over Unicode-aware tokens (0..1). Shared between MemorySystem's
 * duplicate-detection (memory.ts) and the skill curator's overlap detection
 * (cronjob-manager.ts::runSkillCuratorJob) so both use the same, single definition.
 */
export function jaccardSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  // Unicode-aware tokenization: a plain /[^a-z0-9]+/ split treats every umlaut as a word
  // boundary, so "Ausführung" becomes ["ausf","hrung"] and two German strings saying the
  // same thing look unrelated - defeating duplicate/overlap detection.
  const aTokens = new Set(tokenizeText(a, { removeStopwords: false }));
  const bTokens = new Set(tokenizeText(b, { removeStopwords: false }));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection++;
  }

  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersection / union;
}
