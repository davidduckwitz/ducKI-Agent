import { describe, expect, it } from "vitest";
import { isSelfContainedNativeCall } from "../src/agent.ts";
import {
  createAgentForParserTests,
  extractAllToolCalls,
  nativeToolCallsToExtractResult,
} from "./utils/agent-test-harness.ts";

describe("isSelfContainedNativeCall", () => {
  it("returns true for read-only filesystem calls (no content needed)", () => {
    expect(isSelfContainedNativeCall("filesystem", { action: "read", path: "a.txt" })).toBe(true);
    expect(isSelfContainedNativeCall("filesystem", { action: "list", path: "src" })).toBe(true);
    expect(isSelfContainedNativeCall("filesystem", { action: "grep", pattern: "foo" })).toBe(true);
  });

  it("returns true for shell calls (command is always present in native)", () => {
    expect(isSelfContainedNativeCall("shell", { command: "ls -la" })).toBe(true);
  });

  it("returns true for filesystem write WITH content field", () => {
    expect(
      isSelfContainedNativeCall("filesystem", {
        action: "write",
        path: "a.txt",
        content: "hello world",
      }),
    ).toBe(true);
  });

  it("returns true for filesystem write WITH contents field", () => {
    expect(
      isSelfContainedNativeCall("filesystem", {
        action: "append",
        path: "a.txt",
        contents: "more text",
      }),
    ).toBe(true);
  });

  it("returns false for filesystem write WITHOUT content field (bare native)", () => {
    expect(
      isSelfContainedNativeCall("filesystem", {
        action: "write",
        path: "a.txt",
      }),
    ).toBe(false);
  });

  it("returns false for filesystem edit WITHOUT content field", () => {
    expect(
      isSelfContainedNativeCall("filesystem", {
        action: "edit",
        path: "a.txt",
        oldString: "foo",
        newString: "bar",
      }),
    ).toBe(false);
  });

  it("returns true for filesystem edit WITH content field", () => {
    expect(
      isSelfContainedNativeCall("filesystem", {
        action: "edit",
        path: "a.txt",
        content: "replaced content",
      }),
    ).toBe(true);
  });

  it("returns false for filesystem write with empty content string", () => {
    expect(
      isSelfContainedNativeCall("filesystem", {
        action: "write",
        path: "a.txt",
        content: "",
      }),
    ).toBe(false);
  });

  it("returns true for non-mapped tools (always self-contained)", () => {
    expect(isSelfContainedNativeCall("task", { action: "create", title: "Test" })).toBe(true);
    expect(isSelfContainedNativeCall("git", { action: "status" })).toBe(true);
    expect(isSelfContainedNativeCall("diagnostics", { action: "check" })).toBe(true);
  });

  // --- browser tool ---
  it("returns true for browser evaluate WITH script field", () => {
    expect(
      isSelfContainedNativeCall("browser", {
        action: "evaluate",
        script: "document.title",
      }),
    ).toBe(true);
  });

  it("returns false for browser evaluate WITHOUT script field", () => {
    expect(
      isSelfContainedNativeCall("browser", {
        action: "evaluate",
        sessionId: "browser_123",
      }),
    ).toBe(false);
  });

  it("returns false for browser evaluate with empty script string", () => {
    expect(
      isSelfContainedNativeCall("browser", {
        action: "evaluate",
        script: "",
      }),
    ).toBe(false);
  });

  it("returns true for browser non-evaluate actions (no script needed)", () => {
    expect(isSelfContainedNativeCall("browser", { action: "launch" })).toBe(true);
    expect(isSelfContainedNativeCall("browser", { action: "goto", url: "https://x.com" })).toBe(true);
    expect(isSelfContainedNativeCall("browser", { action: "click", selector: "#btn" })).toBe(true);
    expect(isSelfContainedNativeCall("browser", { action: "screenshot" })).toBe(true);
  });

  // --- http tool ---
  it("returns true for http post WITH body field", () => {
    expect(
      isSelfContainedNativeCall("http", {
        action: "post",
        url: "https://api.example.com/users",
        body: { name: "John" },
      }),
    ).toBe(true);
  });

  it("returns false for http post WITHOUT body field", () => {
    expect(
      isSelfContainedNativeCall("http", {
        action: "post",
        url: "https://api.example.com/users",
      }),
    ).toBe(false);
  });

  it("returns true for http put WITH body field", () => {
    expect(
      isSelfContainedNativeCall("http", {
        action: "put",
        url: "https://api.example.com/users/1",
        body: { name: "Jane" },
      }),
    ).toBe(true);
  });

  it("returns true for http patch WITH body field", () => {
    expect(
      isSelfContainedNativeCall("http", {
        action: "patch",
        url: "https://api.example.com/users/1",
        body: { name: "Jane" },
      }),
    ).toBe(true);
  });

  it("returns true for http get (no body needed)", () => {
    expect(
      isSelfContainedNativeCall("http", {
        action: "get",
        url: "https://api.example.com/data",
      }),
    ).toBe(true);
  });

  it("returns true for http delete (no body needed)", () => {
    expect(
      isSelfContainedNativeCall("http", {
        action: "delete",
        url: "https://api.example.com/users/1",
      }),
    ).toBe(true);
  });

  // --- memory tool ---
  it("returns true for memory add WITH content field", () => {
    expect(
      isSelfContainedNativeCall("memory", {
        action: "add",
        content: "User prefers dark mode",
      }),
    ).toBe(true);
  });

  it("returns false for memory add WITHOUT content field", () => {
    expect(
      isSelfContainedNativeCall("memory", {
        action: "add",
      }),
    ).toBe(false);
  });

  it("returns true for memory replace WITH content field", () => {
    expect(
      isSelfContainedNativeCall("memory", {
        action: "replace",
        content: "Updated preference",
      }),
    ).toBe(true);
  });

  it("returns true for memory query (no content needed)", () => {
    expect(
      isSelfContainedNativeCall("memory", {
        action: "query",
        query: "user preferences",
      }),
    ).toBe(true);
  });

  it("returns true for memory list (no content needed)", () => {
    expect(isSelfContainedNativeCall("memory", { action: "list" })).toBe(true);
  });
});

describe("native extraction prioritization integration", () => {
  it("skips text extraction when native calls have content (self-contained)", () => {
    const agent = createAgentForParserTests();
    // Simulate: native call carries content, response also has a heredoc for the same file
    const html = "<html><body>Hi</body></html>";
    const response = `[TOOL:filesystem action=write path=index.html]\n${html}\n[/TOOL]`;

    const nativeResult = nativeToolCallsToExtractResult(agent, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "filesystem",
          arguments: '{"action":"write","path":"index.html","content":"' + html + '"}',
        },
      },
    ]);

    // The native call is self-contained
    expect(nativeResult.calls).toHaveLength(1);
    expect(nativeResult.calls[0]?.input["content"]).toBe(html);

    // Text extraction would find the heredoc — but in the new strategy it should be skipped
    // when native calls are self-contained. We verify the helper decides correctly:
    const allSelfContained = nativeResult.calls.every((c) =>
      isSelfContainedNativeCall(c.toolName, c.input),
    );
    expect(allSelfContained).toBe(true);
  });

  it("requires text extraction when native calls are bare (action/path only)", () => {
    const agent = createAgentForParserTests();
    // Simulate gpt-oss pattern: bare native call + heredoc in text
    const html = "<html><body>Hi</body></html>";
    const response = `[TOOL:filesystem action=write path=index.html]\n${html}\n[/TOOL]`;

    const nativeResult = nativeToolCallsToExtractResult(agent, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "filesystem",
          arguments: '{"action":"write","path":"index.html"}',
        },
      },
    ]);

    // The native call is bare — no content
    expect(nativeResult.calls).toHaveLength(1);
    expect(nativeResult.calls[0]?.input["content"]).toBeUndefined();

    // Not self-contained → text extraction is needed
    const allSelfContained = nativeResult.calls.every((c) =>
      isSelfContainedNativeCall(c.toolName, c.input),
    );
    expect(allSelfContained).toBe(false);

    // Text extraction finds the heredoc
    const textResult = extractAllToolCalls(agent, response);
    expect(textResult.calls).toHaveLength(1);
    expect(textResult.calls[0]?.input["content"]).toBe(html);
  });

  it("text extraction finds heredoc when native calls are bare and response has content", () => {
    const agent = createAgentForParserTests();
    const jsContent = 'console.log("hello");';
    const response = `[TOOL:filesystem action=write path=app.js]\n${jsContent}\n[/TOOL]`;

    const nativeResult = nativeToolCallsToExtractResult(agent, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "filesystem",
          arguments: '{"action":"write","path":"app.js"}',
        },
      },
    ]);

    // Native is bare → text extraction supplements it
    const textResult = extractAllToolCalls(agent, response);
    expect(textResult.calls).toHaveLength(1);
    expect(textResult.calls[0]?.input["content"]).toBe(jsContent);

    // Merging gives us both: native (bare) + text (with content)
    // The dedup step in executeToolCallsFromResponse handles this
    const merged = [...nativeResult.calls, ...textResult.calls];
    expect(merged).toHaveLength(2);
  });

  it("text extraction is not needed when all native calls are read-only", () => {
    const agent = createAgentForParserTests();
    const response = 'Some prose with no tool markers.';

    const nativeResult = nativeToolCallsToExtractResult(agent, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "filesystem",
          arguments: '{"action":"read","path":"src/index.ts"}',
        },
      },
      {
        id: "call_2",
        type: "function",
        function: {
          name: "shell",
          arguments: '{"command":"tsc --noEmit"}',
        },
      },
    ]);

    const allSelfContained = nativeResult.calls.every((c) =>
      isSelfContainedNativeCall(c.toolName, c.input),
    );
    expect(allSelfContained).toBe(true);
  });

  it("detects self-contained browser evaluate (has script)", () => {
    const agent = createAgentForParserTests();

    const nativeResult = nativeToolCallsToExtractResult(agent, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "browser",
          arguments: '{"action":"evaluate","script":"document.title"}',
        },
      },
    ]);

    expect(nativeResult.calls).toHaveLength(1);
    const allSelfContained = nativeResult.calls.every((c) =>
      isSelfContainedNativeCall(c.toolName, c.input),
    );
    expect(allSelfContained).toBe(true);
  });

  it("detects bare browser evaluate (no script) as not self-contained", () => {
    const agent = createAgentForParserTests();

    const nativeResult = nativeToolCallsToExtractResult(agent, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "browser",
          arguments: '{"action":"evaluate","sessionId":"browser_123"}',
        },
      },
    ]);

    expect(nativeResult.calls).toHaveLength(1);
    const allSelfContained = nativeResult.calls.every((c) =>
      isSelfContainedNativeCall(c.toolName, c.input),
    );
    expect(allSelfContained).toBe(false);
  });

  it("detects self-contained http post (has body)", () => {
    const agent = createAgentForParserTests();

    const nativeResult = nativeToolCallsToExtractResult(agent, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "http",
          arguments: '{"action":"post","url":"https://api.example.com/users","body":{"name":"John"}}',
        },
      },
    ]);

    expect(nativeResult.calls).toHaveLength(1);
    const allSelfContained = nativeResult.calls.every((c) =>
      isSelfContainedNativeCall(c.toolName, c.input),
    );
    expect(allSelfContained).toBe(true);
  });

  it("detects bare http post (no body) as not self-contained", () => {
    const agent = createAgentForParserTests();

    const nativeResult = nativeToolCallsToExtractResult(agent, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "http",
          arguments: '{"action":"post","url":"https://api.example.com/users"}',
        },
      },
    ]);

    expect(nativeResult.calls).toHaveLength(1);
    const allSelfContained = nativeResult.calls.every((c) =>
      isSelfContainedNativeCall(c.toolName, c.input),
    );
    expect(allSelfContained).toBe(false);
  });

  it("mixed calls: self-contained + bare → not all self-contained", () => {
    const agent = createAgentForParserTests();

    const nativeResult = nativeToolCallsToExtractResult(agent, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "filesystem",
          arguments: '{"action":"read","path":"src/index.ts"}',
        },
      },
      {
        id: "call_2",
        type: "function",
        function: {
          name: "filesystem",
          arguments: '{"action":"write","path":"out.txt"}',
        },
      },
    ]);

    const allSelfContained = nativeResult.calls.every((c) =>
      isSelfContainedNativeCall(c.toolName, c.input),
    );
    expect(allSelfContained).toBe(false); // bare write makes it not self-contained
  });
});
