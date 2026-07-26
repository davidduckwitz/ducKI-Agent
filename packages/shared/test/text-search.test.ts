import {
  buildMatchSnippet,
  extractKeywords,
  foldGerman,
  scoreKeywordRelevance,
  tokenizeText,
} from "../src/text-search";

describe("tokenizeText", () => {
  test("keeps umlaut words intact instead of splitting on them", () => {
    // The old /[^a-z0-9]+/ tokenizer produced ["ausf", "hrung"] here.
    expect(tokenizeText("Ausführung")).toEqual(["ausfuehrung"]);
    expect(tokenizeText("Prüfung der Größe")).toEqual(["pruefung", "groesse"]);
  });

  test("folds umlaut and ASCII spellings onto the same token", () => {
    expect(tokenizeText("Ausführung")).toEqual(tokenizeText("Ausfuehrung"));
  });

  test("drops German and English stopwords", () => {
    expect(tokenizeText("die Suche in dem Wiki ist not working")).toEqual([
      "suche",
      "wiki",
      "working",
    ]);
  });

  test("can keep stopwords when asked", () => {
    expect(tokenizeText("die Suche", { removeStopwords: false })).toEqual(["die", "suche"]);
  });
});

describe("extractKeywords", () => {
  test("returns distinct meaningful terms from a full sentence", () => {
    // The agent's old extractor took the first 3 long tokens, which here would have been
    // "kannst"/"suche" - dropping "wiki", the only term that identifies the topic.
    expect(extractKeywords("Kannst du die Suche im Wiki verbessern")).toContain("wiki");
  });

  test("deduplicates repeated terms", () => {
    expect(extractKeywords("memory memory memory suche")).toEqual(["memory", "suche"]);
  });

  test("keeps only the topical terms of a conversational question", () => {
    // Observed in a real run: this produced ["updates","status","hast","mich"], so memory
    // was searched for the pronouns of the question instead of just its subject.
    expect(extractKeywords("welche status updates hast du für mich?")).toEqual(["status", "updates"]);
  });
});

describe("scoreKeywordRelevance", () => {
  test("ranks broader term coverage above repetition of one term", () => {
    const broad = scoreKeywordRelevance("Das Memory nutzt die Suche im Wiki", ["memory", "suche", "wiki"]);
    const repetitive = scoreKeywordRelevance("Memory Memory Memory Memory Memory", ["memory", "suche", "wiki"]);
    expect(broad).toBeGreaterThan(repetitive);
  });

  test("matches German compounds via prefix", () => {
    expect(scoreKeywordRelevance("Die Planung laeuft", ["plan"])).toBeGreaterThan(0);
  });

  test("matches across umlaut and ASCII spellings", () => {
    expect(scoreKeywordRelevance("Ausführung gestartet", ["ausfuehrung"])).toBeGreaterThan(0);
    expect(scoreKeywordRelevance("Ausfuehrung gestartet", ["Ausführung"])).toBeGreaterThan(0);
  });

  test("returns zero when nothing matches", () => {
    expect(scoreKeywordRelevance("Ein voellig anderer Text", ["datenbank"])).toBe(0);
  });

  test("stopword-only overlap does not create relevance", () => {
    expect(scoreKeywordRelevance("Das ist der Text", ["der"])).toBe(0);
  });
});

describe("buildMatchSnippet", () => {
  test("returns the passage around the match, not the document head", () => {
    const content = `${"Einleitung ohne Bezug. ".repeat(30)}Der Deploy-Key liegt im Vault.`;
    const snippet = buildMatchSnippet(content, ["vault"]);
    expect(snippet).toContain("Vault");
  });

  test("returns the head when the document is short enough", () => {
    expect(buildMatchSnippet("Kurzer Text", ["text"])).toBe("Kurzer Text");
  });
});

describe("foldGerman", () => {
  test("transcribes umlauts and sharp s", () => {
    expect(foldGerman("Größe Äpfel Über")).toBe("groesse aepfel ueber");
  });
});
