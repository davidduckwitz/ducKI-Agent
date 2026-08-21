import { describe, expect, it } from "vitest";
import { stripStopMarkers, stripTrailingJsonArgTail } from "../src/content-sanitizer.ts";

/**
 * These sanitisers exist to repair a real failure - a weak model closing the content string
 * early, so the tool-call terminator spills into the file body. They must keep doing that.
 *
 * But they used to cut from the FIRST occurrence of any marker, on the assumption that
 * "markers never occur in real code". That is false for the one kind of file this agent writes
 * about itself: documentation. A document explaining the tool format was silently truncated at
 * the sentence that mentioned it - and when the marker sat near the start, the content became
 * an empty string, which the write path reported as "Content required for write" for a call
 * that plainly carried content.
 */
describe("stripStopMarkers - removes leaked terminators", () => {
  it("cuts a terminator at the end", () => {
    expect(stripStopMarkers("<html></html>[/TOOL]")).toBe("<html></html>");
    expect(stripStopMarkers("const a = 1;<|im_end|>")).toBe("const a = 1;");
    expect(stripStopMarkers("<body></body><tool_call|>")).toBe("<body></body>");
  });

  it("cuts a terminator followed only by wrapper punctuation", () => {
    expect(stripStopMarkers('<p>hi</p>[/TOOL]")]')).toBe("<p>hi</p>");
  });

  it("cuts a whole leaked tool call that spilled into the body", () => {
    const leaked = 'export const a = 1;\n[TOOL:filesystem({"action":"write","path":"b.ts"})]';
    // The file's own trailing newline is kept - only the leaked call goes.
    expect(stripStopMarkers(leaked)).toBe("export const a = 1;\n");
  });
});

describe("stripStopMarkers - keeps real content", () => {
  it("keeps documentation that explains the tool syntax", () => {
    const doc = "# Doku\n\nBenutze [TOOL:filesystem] um zu schreiben.\n";
    expect(stripStopMarkers(doc)).toBe(doc);
  });

  it("keeps a document that mentions the closing marker in prose", () => {
    const doc = "Der Block endet mit [/TOOL] auf einer eigenen Zeile.\n\nDanach folgt Text.";
    expect(stripStopMarkers(doc)).toBe(doc);
  });

  it("never reduces content to nothing", () => {
    // The marker IS the content - that is not the leak pattern, and returning "" loses the file.
    expect(stripStopMarkers("[/TOOL]")).toBe("[/TOOL]");
    expect(stripStopMarkers("[TOOL:")).toBe("[TOOL:");
  });

  it("leaves ordinary text and code untouched", () => {
    for (const sample of [
      "# Titel\n\nEin Absatz.\n",
      'export const x = { a: "b" };\n',
      'Er sagte "hallo"',
      "",
    ]) {
      expect(stripStopMarkers(sample), JSON.stringify(sample)).toBe(sample);
    }
  });

  it("passes non-strings through", () => {
    expect(stripStopMarkers(undefined)).toBeUndefined();
    expect(stripStopMarkers(42)).toBe(42);
  });
});

describe("stripTrailingJsonArgTail", () => {
  it("strips a mangled arg-wrapper tail", () => {
    expect(stripTrailingJsonArgTail('<html></html>"}')).toBe("<html></html>");
    expect(stripTrailingJsonArgTail('const a = 1;"})]')).toBe("const a = 1;");
  });

  it("leaves valid JSON alone", () => {
    // A JSON file ends in exactly the `"}` this pattern hunts for. Stripping it produced
    // `{"name":"x`, which the write path then refused as invalid JSON - a write that could
    // not succeed no matter how often the model retried it.
    const json = '{\n  "name": "x"\n}';
    expect(stripTrailingJsonArgTail(json)).toBe(json);
    expect(stripTrailingJsonArgTail('[{"a": "b"}]')).toBe('[{"a": "b"}]');
  });

  it("still strips a tail from JSON-ish content that does not parse", () => {
    expect(stripTrailingJsonArgTail('{"name": "x""}')).toBe('{"name": "x"');
  });

  it("never reduces content to nothing", () => {
    expect(stripTrailingJsonArgTail('"}')).toBe('"}');
  });
});
