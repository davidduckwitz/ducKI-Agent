import { describe, expect, it } from "vitest";
import { recordStreamedSpeech, takeUnstreamedRemainder } from "./streamedSpeechRegistry";

describe("streamedSpeechRegistry", () => {
  it("returns the full text when nothing was streamed", () => {
    expect(takeUnstreamedRemainder("Hallo Welt.")).toBe("Hallo Welt.");
  });

  it("returns nothing when the stream covered the whole message", () => {
    recordStreamedSpeech("Hallo\nWelt.");
    expect(takeUnstreamedRemainder("Hallo Welt.")).toBe("");
  });

  it("returns only the tail the stream never delivered, and consumes the entry", () => {
    recordStreamedSpeech("Erster Satz.");
    expect(takeUnstreamedRemainder("Erster Satz. Zweiter Satz")).toBe("Zweiter Satz");
    expect(takeUnstreamedRemainder("Erster Satz.")).toBe("Erster Satz.");
  });
});
