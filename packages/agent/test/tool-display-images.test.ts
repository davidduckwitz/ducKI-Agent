import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent";

function stubDb() {
  let nextId = 1;
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
    getEverUsedSkills: async () => [],
    createConversation: async (data: { name: string }) => ({ id: 1, name: data.name }),
    addMessage: async (data: any) => ({ id: nextId++, ...data }),
    getMessages: async () => [],
  };
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as any;
}

// Smallest valid JPEG-ish payload is irrelevant here: compressImageBuffer falls back to the raw
// buffer when it cannot decode, and the test only asserts the image reached the vision message.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

function nativeProvider(seen: any[][]) {
  let generation = 0;
  const generate = vi.fn(async (messages: any[]) => {
    seen.push(messages);
    const first = generation++ === 0;
    return {
      content: first ? "" : "Hier ist die Kamera.",
      model: "native-test-model",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
      toolCalls: first
        ? [{ id: "call_cam", type: "function", function: { name: "homeassistant", arguments: '{"action":"get_camera_image","entity_id":"camera.garten"}' } }]
        : [],
    };
  });
  return { model: "native-test-model", generate, generateStream: generate, supportsStreaming: () => false, supportsNativeTools: () => true } as any;
}

describe("tool display_images", () => {
  it("emits a tool_image event for a plugin module tool result and hands the image to vision", async () => {
    const home = mkdtempSync(join(tmpdir(), "ducki-display-images-"));
    const previousHome = process.env["DUCKI_HOME"];
    const previousPlugins = process.env["DUCKI_PLUGINS_DIR"];
    process.env["DUCKI_HOME"] = home;
    process.env["DUCKI_PLUGINS_DIR"] = join(home, "plugins");
    try {
      const { pluginsRoot } = await import("@ducki/shared");
      const snapshotDir = join(pluginsRoot(), "homeassistant", "data", "snapshots");
      mkdirSync(snapshotDir, { recursive: true });
      writeFileSync(join(snapshotDir, "camera.garten-1.jpg"), FAKE_JPEG);

      const seen: any[][] = [];
      const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
      const agent = new Agent(nativeProvider(seen), stubDb(), undefined, {
        enablePlanning: false,
        enableReflection: false,
        disableQualityPasses: true,
        maxIterations: 4,
      });
      const url = "/api/plugins/homeassistant/data/snapshots/camera.garten-1.jpg";
      agent.executor.registerTool({
        name: "homeassistant",
        description: "test",
        definition: { name: "homeassistant", description: "test", parameters: { type: "object", properties: {} } },
        // Module tools wrap their payload as data.result (see plugin-registry buildModuleTool).
        execute: async () => ({
          success: true,
          data: {
            result: {
              ok: true,
              display_images: [
                { url, title: "Garten", caption: "Garten · jetzt" },
                { url: "https://evil.example/x.jpg", title: "remote" },
              ],
            },
          },
        }),
      } as any);

      await agent.run("Zeig mir die Gartenkamera", {
        agentMode: "full",
        onEvent: (event: any) => events.push({ type: event.type, data: event.data }),
      });

      const imageEvents = events.filter((event) => event.type === "tool_image");
      expect(imageEvents).toHaveLength(1);
      // Remote URLs are dropped; only server-local paths may be rendered by the chat.
      expect(imageEvents[0]?.data?.["images"]).toEqual([{ url, title: "Garten", caption: "Garten · jetzt" }]);

      const followUp = seen[1] ?? [];
      const visionMessage = followUp.find((message) => message.metadata?.source === "tool_display_image");
      expect(visionMessage).toBeDefined();
      expect(JSON.stringify(visionMessage.content)).toContain("data:image/jpeg;base64,");
    } finally {
      if (previousHome === undefined) delete process.env["DUCKI_HOME"]; else process.env["DUCKI_HOME"] = previousHome;
      if (previousPlugins === undefined) delete process.env["DUCKI_PLUGINS_DIR"]; else process.env["DUCKI_PLUGINS_DIR"] = previousPlugins;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
