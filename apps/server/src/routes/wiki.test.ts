import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { wikiRouter } from "./wiki.js";

interface MockDb {
  getSetting: (key: string) => Promise<string | undefined>;
  setSetting: (key: string, value: string) => Promise<void>;
  listLlmWikiEntries: (limit?: number) => Promise<unknown[]>;
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
});
