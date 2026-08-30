import { describe, expect, it } from "vitest";
import { normalizeEventContent } from "./eventMeta";

describe("normalizeEventContent", () => {
  it("extracts summary from a JSON-string result", () => {
    expect(normalizeEventContent({ result: '{"Summary":"Änderungen erfolgreich"}' }).text)
      .toBe("Änderungen erfolgreich");
  });

  it("extracts summary from a structured result", () => {
    expect(normalizeEventContent({ result: { summary: "Tests bestanden" } }).text)
      .toBe("Tests bestanden");
  });

  it("supports a direct summary field", () => {
    expect(normalizeEventContent({ summary: "Direkte Zusammenfassung" }).text)
      .toBe("Direkte Zusammenfassung");
  });

  it("keeps plain result text usable", () => {
    expect(normalizeEventContent({ result: "Datei geschrieben" }).text)
      .toBe("Datei geschrieben");
  });

  it("does not treat malformed JSON as a summary object", () => {
    expect(normalizeEventContent({ result: "{not valid json}" }).text)
      .toBe("{not valid json}");
  });
});
