import { describe, it, expect } from "vitest";
import { createAgentForParserTests } from "./utils/agent-test-harness";

/**
 * Regression coverage for the silent 0-byte write.
 *
 * The model emitted a HYBRID of the two documented shapes: a bracket-syntax header followed by
 * a raw heredoc body, with no `[/TOOL]` terminator:
 *
 *   [TOOL:filesystem(action="write", path="index.html")]
 *   <!DOCTYPE html>
 *   ...10 KB of HTML...
 *
 * The strict heredoc matcher rejected it (its header class forbids `(`, and it requires
 * `[/TOOL]`), the JSON scanner then parsed the header into the broken keys `action=` / `path=`,
 * and the 10 KB body was left in the response as prose. The file was created empty while the
 * whole document sat visible in the transcript.
 */
const HTML = [
  "<!DOCTYPE html>",
  '<html lang="de">',
  "<head>",
  '  <meta charset="UTF-8">',
  "  <title>Bitcoin Network Dashboard</title>",
  '  <script src="https://cdn.tailwindcss.com"></script>',
  "  <style>",
  "    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }",
  "  </style>",
  "</head>",
  '<body class="bg-gray-900 text-white">',
  '  <h1 class="text-2xl">Dashboard</h1>',
  "</body>",
  "</html>",
].join("\n");

const extract = (agent: ReturnType<typeof createAgentForParserTests>, response: string) =>
  (agent as any).extractAllToolCalls(response) as {
    calls: Array<{ toolName: string; input: Record<string, unknown> }>;
    markerCount: number;
  };

describe("hybrid header + heredoc body", () => {
  it("recovers the body from a parenthesised header with no terminator", () => {
    const agent = createAgentForParserTests();
    const response = '[TOOL:filesystem(action="write", path="index.html")]\n' + HTML;

    const { calls } = extract(agent, response);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe("filesystem");
    expect(calls[0]!.input["action"]).toBe("write");
    expect(calls[0]!.input["path"]).toBe("index.html");
    expect(calls[0]!.input["content"]).toBe(HTML);
    // Taken verbatim, so the leak-stripping heuristics must not touch it.
    expect(calls[0]!.input["__contentTrusted"]).toBe(true);
  });

  it("does not produce the broken 'action=' / 'path=' keys any more", () => {
    const agent = createAgentForParserTests();
    const { calls } = extract(agent, '[TOOL:filesystem(action="write", path="index.html")]\n' + HTML);

    expect(Object.keys(calls[0]!.input)).not.toContain("action=");
    expect(Object.keys(calls[0]!.input)).not.toContain("path=");
  });

  it("stops the body at an explicit terminator when there is one", () => {
    const agent = createAgentForParserTests();
    const response = '[TOOL:filesystem(action="write", path="a.html")]\n' + HTML + "\n[/TOOL]\nDanach Prosa.";

    const { calls } = extract(agent, response);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input["content"]).toBe(HTML);
    expect(String(calls[0]!.input["content"])).not.toContain("Danach Prosa");
  });

  it("handles unquoted header values", () => {
    const agent = createAgentForParserTests();
    const { calls } = extract(agent, "[TOOL:filesystem(action=write, path=a.md)]\n# Titel\n\nText.");

    expect(calls[0]!.input["action"]).toBe("write");
    expect(calls[0]!.input["path"]).toBe("a.md");
    expect(calls[0]!.input["content"]).toBe("# Titel\n\nText.");
  });

  it("works for append too", () => {
    const agent = createAgentForParserTests();
    const { calls } = extract(agent, '[TOOL:filesystem(action="append", path="a.md")]\nmehr Text');

    expect(calls[0]!.input["action"]).toBe("append");
    expect(calls[0]!.input["content"]).toBe("mehr Text");
  });

  it("does NOT flag a missing terminator as truncated when the file is complete", () => {
    // Regression guard for the fix above: the whole point of this rescue path is a model that
    // wrote a complete file and only forgot [/TOOL] - flagging that as truncated would defeat it.
    const agent = createAgentForParserTests();
    const response = '[TOOL:filesystem(action="write", path="index.html")]\n' + HTML;

    const { calls } = extract(agent, response);

    expect(calls[0]!.input["__argsTruncated"]).toBeUndefined();
  });

  it("flags a body cut off mid-attribute with no terminator as truncated", () => {
    const agent = createAgentForParserTests();
    const cutOffHtml =
      '<!DOCTYPE html>\n<html>\n<body>\n  <span id="totalBalance" style="color:green';
    const response = '[TOOL:filesystem(action="write", path="index.html")]\n' + cutOffHtml;

    const { calls } = extract(agent, response);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input["__argsTruncated"]).toBe(true);
  });

  it("flags a body cut off mid-tag with no terminator as truncated", () => {
    const agent = createAgentForParserTests();
    const cutOffHtml = "<!DOCTYPE html>\n<html>\n<body>\n  <span id=\"brainPass";
    const response = '[TOOL:filesystem(action="write", path="index.html")]\n' + cutOffHtml;

    const { calls } = extract(agent, response);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input["__argsTruncated"]).toBe(true);
  });
});

describe("the tolerant pass must not swallow well-formed calls", () => {
  it("leaves a normal JSON call alone", () => {
    const agent = createAgentForParserTests();
    const response =
      '[TOOL:filesystem({"action":"write","path":"a.md","content":"kurz"})]\nNoch etwas Text danach.';

    const { calls } = extract(agent, response);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input["content"]).toBe("kurz");
    // The prose after the call must not have been appended to the body.
    expect(String(calls[0]!.input["content"])).not.toContain("Noch etwas");
  });

  it("leaves a proper heredoc block alone", () => {
    const agent = createAgentForParserTests();
    const response = "[TOOL:filesystem action=write path=a.md]\n" + HTML + "\n[/TOOL]";

    const { calls } = extract(agent, response);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input["content"]).toBe(HTML);
  });

  it("does not invent a write from a read call followed by prose", () => {
    const agent = createAgentForParserTests();
    const { calls } = extract(agent, '[TOOL:filesystem(action="read", path="a.md")]\nHier steht Fliesstext.');

    // A read has no body; the prose underneath is not content.
    expect(calls.every((c) => c.input["content"] === undefined)).toBe(true);
  });

  it("does not fire when the header already carries the body", () => {
    const agent = createAgentForParserTests();
    const { calls } = extract(agent, '[TOOL:filesystem(action="write", path="a.md", content="drin")]\nProsa.');

    expect(calls[0]!.input["content"]).toBe("drin");
  });

  it("does not fire for a header with no body under it", () => {
    const agent = createAgentForParserTests();
    const { calls } = extract(agent, '[TOOL:filesystem(action="write", path="a.md")]\n\n');

    expect(calls.every((c) => c.input["content"] === undefined || c.input["content"] === "")).toBe(true);
  });

  it("handles two hybrid calls in one response", () => {
    const agent = createAgentForParserTests();
    const response =
      '[TOOL:filesystem(action="write", path="a.md")]\nInhalt A\n' +
      '[TOOL:filesystem(action="write", path="b.md")]\nInhalt B';

    const { calls } = extract(agent, response);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.input["content"]).toBe("Inhalt A");
    expect(calls[1]!.input["content"]).toBe("Inhalt B");
  });
});

/**
 * A following tool call must never end up inside the written file.
 *
 * Both shapes below were found verbatim inside a generated index.html: the model finished the
 * HTML, forgot the closing [/TOOL], and went straight on to its next call. The strict matcher
 * ran lazily to the first [/TOOL] *anywhere below*, so those calls became file content.
 */
describe("a following tool call must not leak into the file body", () => {
  it("stops the body at the next call when the block was left open", () => {
    const agent = createAgentForParserTests();
    const response =
      "[TOOL:filesystem action=write path=index.html]\n" +
      HTML +
      "\n[TOOL:todo action=update id=2 status=in_progress]\nappend";

    const { calls } = extract(agent, response);

    const write = calls.find((c) => c.input["action"] === "write");
    expect(write).toBeDefined();
    expect(write!.input["content"]).toBe(HTML);
    expect(String(write!.input["content"])).not.toContain("[TOOL:todo");
    expect(String(write!.input["content"])).not.toContain("append");
  });

  it("stops the body even when a [/TOOL] follows further down", () => {
    const agent = createAgentForParserTests();
    const response =
      "[TOOL:filesystem action=write path=index.html]\n" +
      HTML +
      "\n[TOOL:todo action=update id=1 status=done]\n[/TOOL]";

    const { calls } = extract(agent, response);

    const write = calls.find((c) => c.input["action"] === "write");
    expect(write!.input["content"]).toBe(HTML);
    expect(String(write!.input["content"])).not.toContain("[TOOL:todo");
  });

  it("handles several calls crammed onto one line after the body", () => {
    const agent = createAgentForParserTests();
    const response =
      "[TOOL:filesystem action=write path=index.html]\n" +
      HTML +
      '\n[TOOL:todo action=update id=1 status=done] [TOOL:todo action=create title="Widgets" priority="medium"]';

    const { calls } = extract(agent, response);

    const write = calls.find((c) => c.input["action"] === "write");
    expect(write!.input["content"]).toBe(HTML);
    expect(String(write!.input["content"])).not.toContain("[TOOL:todo");
  });

  it("still parses the trailing calls as their own calls", () => {
    const agent = createAgentForParserTests();
    const response =
      "[TOOL:filesystem action=write path=index.html]\n" +
      HTML +
      "\n[TOOL:todo action=update id=2 status=in_progress]";

    const { calls } = extract(agent, response);

    // The write is not the only thing recovered - the todo call survives as a real call.
    expect(calls.some((c) => c.toolName === "todo" && c.input["action"] === "update")).toBe(true);
  });

  it("keeps a properly closed block intact", () => {
    const agent = createAgentForParserTests();
    const response = "[TOOL:filesystem action=write path=index.html]\n" + HTML + "\n[/TOOL]";

    const { calls } = extract(agent, response);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input["content"]).toBe(HTML);
  });
});

/**
 * A file that DOCUMENTS the tool format legitimately contains `[TOOL:` and `[/TOOL]` text.
 * The old matcher cut the body at the first such marker - a silently truncated file that
 * still reported success, exactly the "parts missing" symptom.
 */
describe("tool-syntax mentions inside file content must survive", () => {
  it("keeps content after a [/TOOL] line inside the body (strict pass)", () => {
    const agent = createAgentForParserTests();
    const response =
      "[TOOL:filesystem action=write path=docs.md]\n" +
      "# Block format\n" +
      "Close a block with [/TOOL] on its own line.\n" +
      "More documentation after the mention.\n" +
      "[/TOOL]";

    const { calls } = extract(agent, response);

    expect(calls).toHaveLength(1);
    const content = String(calls[0]!.input["content"]);
    expect(content).toContain("Close a block with [/TOOL] on its own line.");
    expect(content).toContain("More documentation after the mention.");
  });

  it("keeps a [TOOL: mention in running text (strict pass)", () => {
    const agent = createAgentForParserTests();
    const response =
      "[TOOL:filesystem action=write path=docs.md]\n" +
      "# Tools\n" +
      "Use [TOOL:filesystem] to read files, e.g. [TOOL:filesystem action=read path=x] to see one.\n" +
      "The end.\n" +
      "[/TOOL]";

    const { calls } = extract(agent, response);

    expect(calls).toHaveLength(1);
    const content = String(calls[0]!.input["content"]);
    expect(content).toContain("[TOOL:filesystem action=read path=x] to see one.");
    expect(content).toContain("The end.");
  });

  it("keeps a [/TOOL] mention in a hybrid block with a real terminator later", () => {
    const agent = createAgentForParserTests();
    const response =
      '[TOOL:filesystem(action="write", path="docs.md")]\n' +
      "Docs mention [/TOOL] here.\n" +
      "More docs.\n" +
      "[/TOOL]";

    const { calls } = extract(agent, response);

    expect(calls).toHaveLength(1);
    const content = String(calls[0]!.input["content"]);
    expect(content).toContain("Docs mention [/TOOL] here.");
    expect(content).toContain("More docs.");
  });

  it("still stops the body at a leaked next call when no terminator exists", () => {
    const agent = createAgentForParserTests();
    const response =
      "[TOOL:filesystem action=write path=index.html]\n" +
      HTML +
      "\n[TOOL:todo action=update id=2 status=in_progress]\nappend";

    const { calls } = extract(agent, response);

    const write = calls.find((c) => c.input["action"] === "write");
    expect(write!.input["content"]).toBe(HTML);
  });

  it("keeps two blocks where the first body mentions the syntax", () => {
    const agent = createAgentForParserTests();
    const response =
      "[TOOL:filesystem action=write path=a.md]\n" +
      "About [/TOOL] syntax.\n" +
      "[/TOOL]\n" +
      "[TOOL:filesystem action=append path=a.md]\n" +
      "Second part.\n" +
      "[/TOOL]";

    const { calls } = extract(agent, response);

    expect(calls).toHaveLength(2);
    expect(String(calls[0]!.input["content"])).toContain("About [/TOOL] syntax.");
    expect(String(calls[1]!.input["content"])).toBe("Second part.");
  });
});
