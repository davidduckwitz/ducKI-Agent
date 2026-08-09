import { describe, expect, it } from "vitest";
import {
  createAgentForParserTests,
  extractAllToolCalls,
  nativeToolCallsToExtractResult,
} from "./utils/agent-test-harness.ts";

describe("heredoc write format", () => {
  it("takes multi-line content verbatim without JSON escaping", () => {
    const agent = createAgentForParserTests();
    const html = '<!doctype html>\n<html>\n  <body>Hello "world"</body>\n</html>';
    const response = `Here is the file:\n[TOOL:filesystem action=write path=index.html]\n${html}\n[/TOOL]\nDone.`;

    const result = extractAllToolCalls(agent, response);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.toolName).toBe("filesystem");
    expect(result.calls[0]?.input["action"]).toBe("write");
    expect(result.calls[0]?.input["path"]).toBe("index.html");
    expect(result.calls[0]?.input["content"]).toBe(html);
    expect(result.unparsed).toHaveLength(0);
  });

  it("does not corrupt content containing braces, parens and the )] terminator", () => {
    const agent = createAgentForParserTests();
    const js = 'function f(){ return [1,2,3].map(x => x*2); } // ends with )]';
    const response = `[TOOL:filesystem action=write path=app.js]\n${js}\n[/TOOL]`;

    const result = extractAllToolCalls(agent, response);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.input["content"]).toBe(js);
  });

  it("supports quoted header values with spaces", () => {
    const agent = createAgentForParserTests();
    const response = `[TOOL:filesystem action=write path="my dir/notes.txt"]\nhello\n[/TOOL]`;

    const result = extractAllToolCalls(agent, response);

    expect(result.calls[0]?.input["path"]).toBe("my dir/notes.txt");
    expect(result.calls[0]?.input["content"]).toBe("hello");
  });

  it("leaves a normal JSON [TOOL:...] call to the JSON scanner (not treated as heredoc)", () => {
    const agent = createAgentForParserTests();
    const response = '[TOOL:filesystem({"action":"read","path":"index.html"})]';

    const result = extractAllToolCalls(agent, response);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.input["action"]).toBe("read");
    expect(result.calls[0]?.input["path"]).toBe("index.html");
  });
});

describe("native tool-call conversion", () => {
  it("maps structured OpenAI tool_calls to the internal call shape", () => {
    const agent = createAgentForParserTests();
    const result = nativeToolCallsToExtractResult(agent, [
      {
        id: "call_1",
        type: "function",
        function: { name: "filesystem", arguments: '{"action":"write","path":"a.txt","content":"hi"}' },
      },
    ]);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.toolName).toBe("filesystem");
    expect(result.calls[0]?.input).toMatchObject({ action: "write", path: "a.txt", content: "hi" });
    // Structured content is marked trusted so the scoped FS tool skips leak-stripping.
    expect(result.calls[0]?.input["__contentTrusted"]).toBe(true);
  });

  it("repairs slightly-malformed native arguments instead of dropping the call", () => {
    const agent = createAgentForParserTests();
    // Trailing comma + single quotes — invalid strict JSON a lenient backend might emit.
    const result = nativeToolCallsToExtractResult(agent, [
      {
        id: "call_2",
        type: "function",
        function: { name: "shell", arguments: "{'command': 'ls -la',}" },
      },
    ]);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.toolName).toBe("shell");
    expect(result.calls[0]?.input["command"]).toBe("ls -la");
  });
});
