/**
 * Shared lexical search primitives for memory recall and wiki search.
 *
 * Both subsystems previously tokenized with `split(/[^a-z0-9]+/)`, which treats every
 * umlaut and sharp-s as a word separator: "Ausfuehrung" survived but "Ausführung" became
 * ["ausf", "hrung"], and "Prüfung" became ["pr", "fung"]. In a German-language product
 * that silently destroyed most of the signal in both the query and the stored content.
 * Neither filtered stopwords either, so "der"/"und"/"the" matched nearly every entry and
 * diluted every relevance score.
 */

/** German + English function words. They carry no retrieval signal but appear in almost
 *  every document, so leaving them in makes every entry look equally relevant. */
const STOPWORDS = new Set([
  // German
  "aber", "alle", "allem", "allen", "aller", "alles", "als", "also", "andere", "anderen",
  "auch", "auf", "aus", "bei", "beim", "bin", "bis", "bist", "dabei", "damit", "dann",
  "das", "dass", "dein", "deine", "dem", "den", "denn", "der", "des", "dessen", "dich",
  "die", "dies", "diese", "diesem", "diesen", "dieser", "dieses", "dir", "doch", "dort",
  "durch", "ein", "eine", "einem", "einen", "einer", "eines", "einige", "er", "es",
  "etwas", "euch", "euer", "eure", "fuer", "für", "gegen", "gern", "gerne", "gewesen",
  "gibt", "hab", "habe", "haben", "hast", "hat", "hatte", "hatten", "heute", "hier",
  "hin", "ich", "ihm", "ihn", "ihnen", "ihr", "ihre", "ihrem", "ihren",
  "ihrer", "im", "immer", "in", "ins", "ist", "ja", "jede", "jedem", "jeden", "jeder", "jedes",
  "jetzt", "kann", "kannst", "koennen", "können", "konnte", "konnten", "machen", "mal",
  "man", "mehr", "mein", "meine", "mich", "mir",
  "mit", "muss", "musst", "muessen", "müssen", "nach", "nicht", "nichts", "noch", "nun",
  "nur", "ob", "oder", "ohne", "schon", "sehr", "sein", "seine", "seit", "sich", "sie",
  "sind", "so", "soll", "sollen", "sollst", "sondern", "sonst", "ueber", "über", "und", "uns",
  "unser", "unsere", "unter", "vielleicht", "vom", "von", "vor", "waehrend", "während",
  "war", "waren",
  "warum", "was", "wegen", "weil", "weiter", "welche", "welcher", "wenn", "wer", "werde",
  "werden", "wie", "wieder", "will", "willst", "wir", "wird", "wirklich", "wirst", "wo",
  "wollen", "wurde", "wurden", "zu",
  "zum", "zur", "zwar", "zwischen",
  // English
  "about", "after", "all", "also", "and", "any", "are", "because", "been", "before",
  "being", "but", "can", "did", "does", "doing", "done", "each", "for", "from", "had",
  "has", "have", "her", "here", "him", "his", "how", "into", "its", "just", "like",
  "make", "many", "may", "more", "most", "must", "not", "now", "off", "once", "only",
  "other", "our", "out", "over", "own", "same", "she", "should", "some", "such", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "those",
  "through", "too", "under", "until", "very", "was", "way", "were", "what", "when",
  "where", "which", "while", "who", "why", "will", "with", "would", "you", "your",
]);

/** Unicode-aware word split: keeps letters from any script (so umlauts stay inside their
 *  word), digits, underscore and hyphen. Everything else separates. */
const WORD_SPLIT = /[^\p{L}\p{N}_-]+/u;

/** Folds German umlauts to their ASCII transcription so "Ausführung" and "Ausfuehrung"
 *  are the same token - the codebase writes both spellings (plan markdown uses ASCII,
 *  user input uses umlauts), and neither should miss the other. */
export function foldGerman(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

export interface TokenizeOptions {
  /** Drop function words. Default true. */
  removeStopwords?: boolean;
  /** Shortest token to keep. Default 3. */
  minLength?: number;
}

/** Splits text into normalized, stopword-filtered search tokens. */
export function tokenizeText(value: string, options: TokenizeOptions = {}): string[] {
  const { removeStopwords = true, minLength = 3 } = options;
  if (!value) return [];

  return foldGerman(value)
    .split(WORD_SPLIT)
    .map((token) => token.replace(/^[-_]+|[-_]+$/g, ""))
    .filter((token) => {
      if (token.length < minLength) return false;
      if (removeStopwords && STOPWORDS.has(token)) return false;
      return true;
    });
}

/** Distinct search tokens, in first-seen order. */
export function extractKeywords(value: string, limit = 12, options: TokenizeOptions = {}): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokenizeText(value, options)) {
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Scores how well `content` answers `keywords`.
 *
 * Coverage (how many distinct query terms appear at all) dominates term frequency, so an
 * entry mentioning three different query terms once each outranks one that repeats a
 * single term ten times. Prefix matches count at reduced weight, which is what makes
 * German compounds findable: a query for "memory" still hits "memorysystem", and
 * "plan" hits "planung".
 */
export function scoreKeywordRelevance(content: string, keywords: string[]): number {
  if (keywords.length === 0 || !content) return 0;

  const contentTokens = tokenizeText(content, { removeStopwords: false, minLength: 2 });
  if (contentTokens.length === 0) return 0;

  // A stopword passed in as a keyword would match nearly every document, so it must not
  // contribute - and must not count toward coverage either, or it would drag every real
  // hit's score down. Callers normally pass extractKeywords() output (already filtered),
  // but the memory tool forwards whatever the model asked for.
  const effectiveKeywords = keywords.filter((keyword) => tokenizeText(keyword).length > 0);
  if (effectiveKeywords.length === 0) return 0;

  const frequencies = new Map<string, number>();
  for (const token of contentTokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  let matched = 0;
  let weight = 0;
  for (const rawKeyword of effectiveKeywords) {
    const keyword = foldGerman(rawKeyword).trim();
    if (!keyword) continue;

    const exact = frequencies.get(keyword) ?? 0;
    if (exact > 0) {
      matched += 1;
      // Diminishing returns: the 10th repetition of a term says little more than the 2nd.
      weight += 1 + Math.min(0.5, Math.log10(1 + exact) / 2);
      continue;
    }

    let prefixHit = false;
    for (const token of frequencies.keys()) {
      if (token.length > keyword.length && token.startsWith(keyword)) {
        prefixHit = true;
        break;
      }
    }
    if (prefixHit) {
      matched += 1;
      weight += 0.5;
    }
  }

  if (matched === 0) return 0;

  const coverage = matched / effectiveKeywords.length;
  return coverage * 2 + weight / effectiveKeywords.length;
}

/**
 * Returns the window of `content` that actually contains the query terms, so a search
 * result preview shows the matching passage instead of whatever happened to be in the
 * first N characters of the document.
 */
export function buildMatchSnippet(content: string, keywords: string[], length = 240): string {
  const trimmed = content.trim();
  if (trimmed.length <= length || keywords.length === 0) return trimmed.slice(0, length);

  const haystack = foldGerman(trimmed);
  let bestIndex = -1;
  for (const rawKeyword of keywords) {
    const keyword = foldGerman(rawKeyword).trim();
    if (!keyword) continue;
    const index = haystack.indexOf(keyword);
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) bestIndex = index;
  }

  if (bestIndex < 0) return trimmed.slice(0, length);

  const start = Math.max(0, bestIndex - Math.floor(length / 4));
  const end = Math.min(trimmed.length, start + length);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < trimmed.length ? "..." : "";
  return `${prefix}${trimmed.slice(start, end).trim()}${suffix}`;
}
