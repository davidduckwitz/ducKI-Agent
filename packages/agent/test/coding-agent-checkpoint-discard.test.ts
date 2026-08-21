import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent";
import { listCheckpoints } from "../src/coding/checkpoints.js";

/**
 * The CodingAgent snapshots the sandbox before every attempt. An attempt that changed
 * nothing (the model only read/explored) must not leave an empty checkpoint behind - the
 * Changes tab would drown in no-op entries. These tests pin that behavior for the plan
 * path, mirroring the chat-path discard in the websocket handler.
 */
function stubDb() {
  let nextId = 1;
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
    createConversation: async (data: { name: string }) => ({ id: nextId++, name: data.name }),
  };
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as any;
}

function scriptedProvider(contents: string[]) {
  let index = 0;
  const next = () => {
    const content = contents[Math.min(index, contents.length - 1)] ?? "done";
    index++;
    return {
      content,
      model: "test-model",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    };
  };
  return {
    model: "test-model",
    generate: async () => next(),
    generateStream: async () => next(),
    supportsStreaming: () => false,
  } as any;
}

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
});

describe("CodingAgent no-op checkpoint discard", () => {
  it("discards the checkpoint when the attempt changed no files", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-cp-noop-"));
    sandboxes.push(sandbox);
    // The model answers without a single tool call - the attempt writes nothing.
    const provider = scriptedProvider(["Fertig."]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    await codingAgent.run("beantworte nur, schreibe nichts", { maxAttempts: 1 });

    expect(await listCheckpoints(sandbox)).toHaveLength(0);
  });

  it("keeps the checkpoint when the attempt wrote a file", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-cp-write-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      "[TOOL:filesystem action=write path=app.js]\ncontent\n[/TOOL]",
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    await codingAgent.run("schreibe app.js", { maxAttempts: 1 });

    const checkpoints = await listCheckpoints(sandbox);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.label).toContain("Before attempt 1");
  });
});
