import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { wikiRouter } from "./wiki.js";

interface MockDb {
  getSetting: (key: string) => Promise<string | undefined>;
  setSetting: (key: string, value: string) => Promise<void>;
  listLlmWikiEntries: (limit?: number) => Promise<unknown[]>;
  listLlmWikiLinks?: (status?: "active" | "all") => Promise<unknown[]>;
  createManualLink?: (sourceFile: string, targetFile: string) => Promise<unknown>;
  removeLlmWikiLink?: (id: number) => Promise<unknown>;
}

interface MockWikiService {
  getStats: () => unknown;
  ingestNow: () => Promise<unknown>;
  listEntries: (limit?: number, status?: string) => Promise<unknown[]>;
  search: (query: string, limit?: number, includeCandidates?: boolean) => Promise<unknown[]>;
  setEntryStatus: (id: number, status: "approved" | "rejected") => Promise<unknown>;
}

const openServers: Server[] = [];

async function startTestServer(db: MockDb, wikiService: MockWikiService): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.locals["db"] = db;
  app.locals["wikiService"] = wikiService;
  app.use("/api/wiki", wikiRouter);

  const server = createServer(app);
  openServers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to acquire test server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (!server) continue;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

describe("wiki router", () => {
  it("returns 400 on reindex when WIKI_ENABLED is false", async () => {
    const db: MockDb = {
      async getSetting(key: string) {
        if (key === "WIKI_ENABLED") return "false";
        return undefined;
      },
      async setSetting() {},
      async listLlmWikiEntries() {
        return [];
      },
    };

    let ingestCalls = 0;
    const wikiService: MockWikiService = {
      getStats: () => ({ scannedFiles: 0 }),
      async ingestNow() {
        ingestCalls += 1;
        return { processedFiles: 0 };
      },
      async listEntries() {
        return [];
      },
      async search() {
        return [];
      },
      async setEntryStatus() {
        return { id: 1, status: "approved" };
      },
    };

    const server = await startTestServer(db, wikiService);
    const response = await fetch(`${server.baseUrl}/api/wiki/reindex`, { method: "POST" });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body?.error ?? "").toContain("WIKI_ENABLED=false");
    expect(ingestCalls).toBe(0);
    await server.close();
  });

  it("reindexes successfully when WIKI_ENABLED is true", async () => {
    const db: MockDb = {
      async getSetting(key: string) {
        if (key === "WIKI_ENABLED") return "true";
        return undefined;
      },
      async setSetting() {},
      async listLlmWikiEntries() {
        return [];
      },
    };

    let ingestCalls = 0;
    const wikiService: MockWikiService = {
      getStats: () => ({ scannedFiles: 0 }),
      async ingestNow() {
        ingestCalls += 1;
        return { scannedFiles: 2, processedFiles: 2 };
      },
      async listEntries() {
        return [];
      },
      async search() {
        return [];
      },
      async setEntryStatus() {
        return { id: 1, status: "approved" };
      },
    };

    const server = await startTestServer(db, wikiService);
    const response = await fetch(`${server.baseUrl}/api/wiki/reindex`, { method: "POST" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body?.data?.reindexed).toBe(true);
    expect(ingestCalls).toBe(1);
    await server.close();
  });

  it("returns the configured sourcePath in status and rejects path traversal in config", async () => {
    const settings = new Map<string, string>([["WIKI_SHARED_SOURCE_PATH", "my-obsidian-vault"]]);
    const db: MockDb = {
      async getSetting(key: string) {
        return settings.get(key);
      },
      async setSetting(key: string, value: string) {
        settings.set(key, value);
      },
      async listLlmWikiEntries() {
        return [];
      },
    };
    const wikiService: MockWikiService = {
      getStats: () => ({}),
      async ingestNow() {
        return {};
      },
      async listEntries() {
        return [];
      },
      async search() {
        return [];
      },
      async setEntryStatus() {
        return { id: 1, status: "approved" };
      },
    };

    const server = await startTestServer(db, wikiService);

    const statusResponse = await fetch(`${server.baseUrl}/api/wiki/status`);
    const statusBody = await statusResponse.json();
    expect(statusBody.data.config.sourcePath).toBe("my-obsidian-vault");

    const badConfigResponse = await fetch(`${server.baseUrl}/api/wiki/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePath: "../../etc" }),
    });
    expect(badConfigResponse.status).toBe(400);
    expect(settings.get("WIKI_SHARED_SOURCE_PATH")).toBe("my-obsidian-vault");

    const goodConfigResponse = await fetch(`${server.baseUrl}/api/wiki/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePath: "second-vault" }),
    });
    expect(goodConfigResponse.status).toBe(200);
    expect(settings.get("WIKI_SHARED_SOURCE_PATH")).toBe("second-vault");
    await server.close();
  });

  it("builds one graph node per source file and reports edges", async () => {
    const db: MockDb = {
      async getSetting() {
        return undefined;
      },
      async setSetting() {},
      async listLlmWikiEntries() {
        return [
          {
            id: 1,
            sourcePath: "foo.md#chunk-1",
            status: "approved",
            metadata: JSON.stringify({ sourceFile: "foo.md", tags: ["a"] }),
          },
          {
            id: 2,
            sourcePath: "foo.md#chunk-2",
            status: "approved",
            metadata: JSON.stringify({ sourceFile: "foo.md", tags: ["a"] }),
          },
          {
            id: 3,
            sourcePath: "bar.md#chunk-1",
            status: "candidate",
            metadata: JSON.stringify({ sourceFile: "bar.md", tags: [] }),
          },
        ];
      },
      async listLlmWikiLinks() {
        return [{ id: 10, sourceFile: "foo.md", targetRaw: "Bar", targetFile: "bar.md", origin: "parsed" }];
      },
    };

    const wikiService: MockWikiService = {
      getStats: () => ({}),
      async ingestNow() {
        return {};
      },
      async listEntries() {
        return [];
      },
      async search() {
        return [];
      },
      async setEntryStatus() {
        return { id: 1, status: "approved" };
      },
    };

    const server = await startTestServer(db, wikiService);
    const response = await fetch(`${server.baseUrl}/api/wiki/graph`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.nodes).toHaveLength(2);
    expect(body.data.edges).toEqual([{ id: 10, source: "foo.md", target: "bar.md", origin: "parsed", resolved: true }]);
    const fooNode = body.data.nodes.find((n: { id: string }) => n.id === "foo.md");
    expect(fooNode.degree).toBe(1);
    await server.close();
  });

  it("creates a manual link via POST /links", async () => {
    let created: unknown;
    const db: MockDb = {
      async getSetting() {
        return undefined;
      },
      async setSetting() {},
      async listLlmWikiEntries() {
        return [];
      },
      async createManualLink(sourceFile: string, targetFile: string) {
        created = { sourceFile, targetFile };
        return { id: 5, sourceFile, targetFile, origin: "manual", status: "active" };
      },
    };
    const wikiService: MockWikiService = {
      getStats: () => ({}),
      async ingestNow() {
        return {};
      },
      async listEntries() {
        return [];
      },
      async search() {
        return [];
      },
      async setEntryStatus() {
        return { id: 1, status: "approved" };
      },
    };

    const server = await startTestServer(db, wikiService);
    const response = await fetch(`${server.baseUrl}/api/wiki/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceFile: "foo.md", targetFile: "bar.md" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.origin).toBe("manual");
    expect(created).toEqual({ sourceFile: "foo.md", targetFile: "bar.md" });
    await server.close();
  });

  it("removes a link via DELETE /links/:id", async () => {
    let removedId: number | undefined;
    const db: MockDb = {
      async getSetting() {
        return undefined;
      },
      async setSetting() {},
      async listLlmWikiEntries() {
        return [];
      },
      async removeLlmWikiLink(id: number) {
        removedId = id;
        return { id, status: "removed" };
      },
    };
    const wikiService: MockWikiService = {
      getStats: () => ({}),
      async ingestNow() {
        return {};
      },
      async listEntries() {
        return [];
      },
      async search() {
        return [];
      },
      async setEntryStatus() {
        return { id: 1, status: "approved" };
      },
    };

    const server = await startTestServer(db, wikiService);
    const response = await fetch(`${server.baseUrl}/api/wiki/links/7`, { method: "DELETE" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.removed).toBe(true);
    expect(removedId).toBe(7);
    await server.close();
  });
});
