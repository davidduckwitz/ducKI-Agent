import { describe, it, expect } from "vitest";
import { createAgentForParserTests } from "./utils/agent-test-harness";

describe("Tool Call Parser – Bracket Payload Handling (PR1-A1)", () => {
  describe("extractAllToolCalls with complex payloads", () => {
    it("parses two calls where one has array with ] inside", () => {
      const agent = createAgentForParserTests();
      const response = `[TOOL:filesystem({"action":"write","path":"a.json","content":"[1,2,3]"})] OK, then [TOOL:shell({"command":"echo hi"})]`;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.markerCount).toBe(2);
      expect(result.calls).toHaveLength(2);
      expect(result.calls[0].toolName).toBe("filesystem");
      expect(result.calls[0].input.content).toBe("[1,2,3]");
      expect(result.calls[1].toolName).toBe("shell");
      expect(result.unparsed).toHaveLength(0);
    });

    it("reports unparsed marker when body cannot be parsed", () => {
      const agent = createAgentForParserTests();
      // toolname starting with number is invalid; body has no valid format
      const response = `[TOOL:filesystem({"action":"write"})] and [TOOL:9invalid({incomplete`;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.markerCount).toBe(2);
      expect(result.calls).toHaveLength(1); // only the first parses
      expect(result.calls[0].toolName).toBe("filesystem");
      expect(result.unparsed).toHaveLength(1);
    });

    it("handles nested array in string correctly", () => {
      const agent = createAgentForParserTests();
      const response = `[TOOL:filesystem({"action":"write","path":"data.json","content":"{\\"items\\":[[1,2],[3,4]]}"})]`;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.markerCount).toBe(1);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].input.content).toContain("[[1,2],[3,4]]");
      expect(result.unparsed).toHaveLength(0);
    });

    it("single marker still returns via extractAllToolCalls", () => {
      const agent = createAgentForParserTests();
      const response = `[TOOL:shell({"command":"ls -la"})]`;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.markerCount).toBe(1);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].toolName).toBe("shell");
      expect(result.unparsed).toHaveLength(0);
    });
  });

  describe("space-separated key=value bracket calls (Variant E)", () => {
    it("parses the exact failing filesystem write from the report (quotes, newlines, parens, URLs)", () => {
      const agent = createAgentForParserTests();
      const response =
        '[TOOL:filesystem action=write path=./weather_news_report.md basePath=./shared-workspace ' +
        'content="# Wetter- und Nachrichtenbericht\\n\\n## Wetter in Fulda\\n- **Temperatur:** 22,6 °C\\n\\n' +
        '1. **Schlichtung bei Lufthansa** (tagesschau)\\n   <https://www.tagesschau.de/x.html>"]';

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.calls).toHaveLength(1);
      expect(result.unparsed).toHaveLength(0);
      const call = result.calls[0];
      expect(call.toolName).toBe("filesystem");
      expect(call.input.action).toBe("write");
      expect(call.input.path).toBe("./weather_news_report.md");
      expect(call.input.basePath).toBe("./shared-workspace");
      // Escaped \n became a real newline; parens and <url> survived intact.
      expect(call.input.content).toContain("# Wetter- und Nachrichtenbericht\n");
      expect(call.input.content).toContain("(tagesschau)");
      expect(call.input.content).toContain("<https://www.tagesschau.de/x.html>");
    });

    it("parses bare and single-quoted values", () => {
      const agent = createAgentForParserTests();
      const result = (agent as any).extractAllToolCalls("[TOOL:filesystem action=read path='./my file.md']");
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].input.action).toBe("read");
      expect(result.calls[0].input.path).toBe("./my file.md");
      expect(result.unparsed).toHaveLength(0);
    });

    it("still prefers JSON payloads (Variant E does not shadow them)", () => {
      const agent = createAgentForParserTests();
      const result = (agent as any).extractAllToolCalls('[TOOL:shell({"command":"echo hi=there"})]');
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].input.command).toBe("echo hi=there");
    });
  });

  describe("content with raw, unescaped inner quotes (HTML attributes)", () => {
    // Reproduces a real coding-agent failure: the model wrote a full HTML page as the `content`
    // argument of a function-call-style bracket call, but - since it was authoring markup, not
    // hand-escaping a JSON string - left every attribute quote raw (`charset="UTF-8"`, not
    // `charset=\"UTF-8\"`). The naive last-resort parser used to stop `content` at the FIRST such
    // quote and misread every attribute after it as more top-level key:value pairs, destroying
    // `action`/`path` and truncating `content` to a few characters. It only manifested for HTML
    // (dense with `attr="value"` pairs) - JS/CSS/JSON writes never hit this, which is exactly why
    // "every file but the .html one" kept failing in practice.
    it("keeps a content value intact past raw unescaped double quotes inside HTML", () => {
      const agent = createAgentForParserTests();
      const html =
        '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        '<link rel="stylesheet" href="style.css"></head>' +
        '<body><div class="app" id="calc"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"></circle></svg></div>' +
        '</body></html>';
      const response = `[TOOL: filesystem(action:"write", path="index.html", content="${html}")]`;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.calls).toHaveLength(1);
      expect(result.unparsed).toHaveLength(0);
      const call = result.calls[0];
      expect(call.toolName).toBe("filesystem");
      expect(call.input.action).toBe("write");
      expect(call.input.path).toBe("index.html");
      expect(call.input.content).toBe(html);
      // The bug's signature: stray HTML attribute names leaking in as bogus top-level keys.
      expect(call.input.charset).toBeUndefined();
      expect(call.input.viewBox).toBeUndefined();
    });

    it("still ends the value at a quote genuinely followed by a separator", () => {
      const agent = createAgentForParserTests();
      // Consistent colon separators throughout, matching how a model actually writes one of
      // these calls (it never mixes `:` and `=` within a single call) - a mixed-separator string
      // is a self-inflicted edge case a real model wouldn't produce, not something worth hardening
      // against here.
      const response = '[TOOL: filesystem(action:"write", path:"a.txt", content:"hello world")]';

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].input.action).toBe("write");
      expect(result.calls[0].input.content).toBe("hello world");
    });
  });

  describe("colon-style call misdetected as key=value because content contains attr=\"value\"", () => {
    // The ACTUAL bug behind a real "index.html never gets written, every other file is fine"
    // report. parseBracketBody's key=value-list detection used to be
    // `/[A-Za-z_][A-Za-z0-9_\-]*\s*=/.test(inner)` - unanchored, so it fired the moment `=`
    // appeared ANYWHERE in the argument text. A colon-style call
    // (`filesystem(action:"write", path:"index.html", content:"<meta charset=\"UTF-8\">...")`)
    // has its `content` value stuffed with `attr="value"` HTML pairs, which are `=`-joined even
    // though the call itself is entirely `:`-joined. That false-positive routed the WHOLE call
    // through parseHeredocHeader, a flat `key=value` scanner that: (a) never matches `action:`/
    // `path:` at all since it only recognises `=`, so `action`/`path` silently vanish, and
    // (b) reconstructs bogus top-level keys from the markup inside `content` (`charset`,
    // `viewBox`, `cx`, `stdDeviation`, ...) - exactly the symptom seen in production. Also
    // reproduces the model's actual malformed terminator (a stray `}` with no closing `)]`,
    // since it opened with `(` not `{`) to prove the fix holds through scanBracketPayload's
    // "unterminated, take the rest" fallback too - not a synthetic, well-closed call.
    it("keeps action/path and does not leak HTML attributes as top-level keys", () => {
      const agent = createAgentForParserTests();
      const response =
        '[TOOL: filesystem(action:"write", path="index.html", content="<!DOCTYPE html>\\n' +
        '<html lang=\\"de\\">\\n<head>\\n<meta charset=\\"UTF-8\\">\\n' +
        '<link rel=\\"stylesheet\\" href=\\"style.css\\">\\n</head>\\n' +
        '<body>\\n<svg viewBox=\\"0 0 10 10\\"><circle cx=\\"5\\" cy=\\"5\\" r=\\"4\\"/></svg>\\n' +
        '</body>\\n</html>"}';

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.calls).toHaveLength(1);
      const call = result.calls[0];
      expect(call.toolName).toBe("filesystem");
      expect(call.input.action).toBe("write");
      expect(call.input.path).toBe("index.html");
      expect(call.input.content).toContain("<!DOCTYPE html>");
      expect(call.input.content).toContain('charset="UTF-8"');
      expect(call.input.content).toContain("</html>");
      // The bug's signature: stray HTML attribute names leaking in as bogus top-level keys.
      expect(call.input.charset).toBeUndefined();
      expect(call.input.viewBox).toBeUndefined();
      expect(call.input.cx).toBeUndefined();
    });

    it("still uses the key=value reader for a genuine equals-style call", () => {
      const agent = createAgentForParserTests();
      const response = '[TOOL: filesystem(action="write", path="a.md", content="# Title")]';

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].input.action).toBe("write");
      expect(result.calls[0].input.path).toBe("a.md");
      expect(result.calls[0].input.content).toBe("# Title");
    });
  });

  describe("scanBracketPayload helper", () => {
    it("correctly finds closing bracket at any nesting depth", () => {
      const agent = createAgentForParserTests();
      const text = `filesystem({"nested":{"deep":{"data":"[1,2,3]"}}})`;

      const result = (agent as any).scanBracketPayload(text, 0);

      expect(result).toBeDefined();
      expect(result!.body).toContain("nested");
      expect(result!.endIndex).toBeGreaterThan(0);
    });

    it("returns undefined for empty start pos", () => {
      const agent = createAgentForParserTests();
      const result = (agent as any).scanBracketPayload("", 0);

      expect(result).toBeUndefined();
    });

    it("handles unclosed bracket (fallback to rest of string)", () => {
      const agent = createAgentForParserTests();
      const text = `filesystem({"action":"read"`;

      const result = (agent as any).scanBracketPayload(text, 0);

      expect(result).toBeDefined();
      expect(result!.body).toContain("action");
    });

    it("keeps full multi-line body on unterminated payload (does not cut at first newline)", () => {
      const agent = createAgentForParserTests();
      // Real newlines inside content, and truncated before the closing `})` -
      // mirrors the write_file failure where the body was cut at line one.
      const text = `write_file({"path":"a.md","content":"# Title\nsecond line\nthird line`;

      const result = (agent as any).scanBracketPayload(text, 0);

      expect(result).toBeDefined();
      expect(result!.body).toContain("second line");
      expect(result!.body).toContain("third line");
    });
  });

  describe("literal newlines inside string values", () => {
    it("parses write_file whose content has raw (unescaped) newlines", () => {
      const agent = createAgentForParserTests();
      const content = "# Konzept\n\n## 1. Einleitung\nText mit (Klammern) und Umlauten.";
      const response = `[TOOL:write_file({"path":"./shared-workspace/x.md","content":"${content}"})]`;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.markerCount).toBe(1);
      expect(result.calls).toHaveLength(1);
      // write_file resolves onto the filesystem tool with action "write"
      expect(result.calls[0].toolName).toBe("filesystem");
      expect(result.calls[0].input.action).toBe("write");
      expect(result.calls[0].input.content).toBe(content);
      expect(result.unparsed).toHaveLength(0);
    });
  });
});
