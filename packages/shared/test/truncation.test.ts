import { isIncompleteResponse, isLikelyTruncatedByLength } from "../src/index";

describe("isIncompleteResponse", () => {
  test("true for a length cutoff or a broken stream", () => {
    expect(isIncompleteResponse("length")).toBe(true);
    expect(isIncompleteResponse("incomplete_stream")).toBe(true);
  });

  test("false for a clean stop and for unknown reasons", () => {
    expect(isIncompleteResponse("stop")).toBe(false);
    expect(isIncompleteResponse(undefined)).toBe(false);
  });
});

/**
 * Regression coverage for the length-ratio truncation guard: a backend that silently caps
 * output below the requested maxTokens but still reports a clean finish_reason ("stop") is
 * exactly the case isIncompleteResponse cannot catch on its own - see the comment on the
 * function for why this mirrors Aider's own silent-truncation heuristic.
 */
describe("isLikelyTruncatedByLength", () => {
  test("true once completion tokens land at/above the threshold ratio of the cap", () => {
    expect(isLikelyTruncatedByLength(921, 1000)).toBe(true);
    expect(isLikelyTruncatedByLength(1000, 1000)).toBe(true);
  });

  test("false comfortably below the threshold", () => {
    expect(isLikelyTruncatedByLength(500, 1000)).toBe(false);
    expect(isLikelyTruncatedByLength(919, 1000)).toBe(false);
  });

  test("false when either number is missing or the cap is non-positive", () => {
    expect(isLikelyTruncatedByLength(undefined, 1000)).toBe(false);
    expect(isLikelyTruncatedByLength(950, undefined)).toBe(false);
    expect(isLikelyTruncatedByLength(0, 1000)).toBe(false);
    expect(isLikelyTruncatedByLength(950, 0)).toBe(false);
  });

  test("a custom threshold ratio is honored", () => {
    expect(isLikelyTruncatedByLength(600, 1000, 0.5)).toBe(true);
    expect(isLikelyTruncatedByLength(400, 1000, 0.5)).toBe(false);
  });
});
