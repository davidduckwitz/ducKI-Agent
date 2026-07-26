import { summarizeToolCall } from "../src/tools/tool-summary";

describe("summarizeToolCall", () => {
  test("names the file a filesystem action touches", () => {
    expect(summarizeToolCall("filesystem", { action: "read", path: "src/app.ts" })).toBe("read src/app.ts");
  });

  test("shortens deep paths to the last two segments", () => {
    const summary = summarizeToolCall("filesystem", {
      action: "edit",
      path: "M:/projekte/ducki-node/apps/web/src/components/chat/ChatContainer.tsx",
    });
    expect(summary).toBe("edit …/chat/ChatContainer.tsx");
  });

  test("shows the actual shell command", () => {
    expect(summarizeToolCall("shell", { command: "npm test" })).toBe("$ npm test");
  });

  test("shows the query for knowledge tools", () => {
    expect(summarizeToolCall("wiki", { action: "search", query: "deploy" })).toBe('search "deploy"');
  });

  test("falls back to tool and action when no argument stands out", () => {
    expect(summarizeToolCall("workflow", { action: "list" })).toBe("workflow list");
  });

  test("falls back to the bare tool name for an empty input", () => {
    expect(summarizeToolCall("browser", {})).toBe("browser");
  });

  test("truncates overlong commands instead of flooding the chat row", () => {
    const summary = summarizeToolCall("shell", { command: "x".repeat(400) });
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary.endsWith("…")).toBe(true);
  });

  test("collapses newlines so a multi-line command stays one row", () => {
    expect(summarizeToolCall("shell", { command: "npm run build\nnpm test" })).toBe("$ npm run build npm test");
  });
});
