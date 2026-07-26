import { splitMarkdownSegments } from "./markdownSegments";

describe("splitMarkdownSegments", () => {
  test("separates prose from a fenced code block", () => {
    const result = splitMarkdownSegments("Hier der Fix:\n```ts\nconst a = 1;\n```\nFertig.");

    expect(result).toHaveLength(3);
    expect(result[0]?.type).toBe("text");
    expect(result[1]).toMatchObject({ type: "code", language: "ts", content: "const a = 1;\n" });
    expect(result[2]?.type).toBe("text");
  });

  test("defaults the language when the fence has none", () => {
    const result = splitMarkdownSegments("```\nplain\n```");
    expect(result[0]).toMatchObject({ type: "code", language: "text" });
  });

  test("treats a still-streaming unterminated fence as code", () => {
    const result = splitMarkdownSegments("Text\n```py\nprint(1)");
    expect(result[1]).toMatchObject({ type: "code", language: "py", content: "print(1)" });
  });

  test("handles several code blocks in one message", () => {
    const result = splitMarkdownSegments("```a\n1\n```\nmitte\n```b\n2\n```");
    expect(result.filter((s) => s.type === "code")).toHaveLength(2);
  });

  test("returns a single text segment when there is no code", () => {
    const result = splitMarkdownSegments("nur Text");
    expect(result).toEqual([{ type: "text", content: "nur Text" }]);
  });

  test("drops whitespace-only prose between blocks", () => {
    const result = splitMarkdownSegments("```a\n1\n```\n\n```b\n2\n```");
    expect(result.every((s) => s.type === "code")).toBe(true);
  });

  test("handles empty input", () => {
    expect(splitMarkdownSegments("")).toEqual([]);
  });
});
