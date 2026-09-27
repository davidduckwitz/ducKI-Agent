import express from "express";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codingRouter, readLinkedProjects, resolveCodingSandboxRoot } from "./coding.js";

/** Linked projects work on a user's folder in place - removing one must never delete that folder. */

const openServers: Server[] = [];

async function startTestServer(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.locals["db"] = {
    getSetting: async (key: string) => (key === "CODING_ENABLED" ? "true" : undefined),
    listConversations: async () => [],
    getConversation: async () => undefined,
    getMessages: async () => [],
    deleteConversation: async () => {},
  };
  app.use("/api/coding", codingRouter);
  const server = createServer(app);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return `http://127.0.0.1:${address.port}/api/coding`;
}

describe("linked coding projects", () => {
  let folder: string;
  let slug: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "ducki-link-"));
    mkdirSync(join(folder, "src"));
    writeFileSync(join(folder, "src", "main.ts"), "export const x = 1;");
    slug = `vitest-link-${Date.now().toString(36)}`;
  });

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    rmSync(folder, { recursive: true, force: true });
  });

  it("links a folder, serves its files, resolves the agent sandbox, and unlinks without deleting", async () => {
    const base = await startTestServer();
    const post = (body: unknown) =>
      fetch(`${base}/projects/link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const linked = (await (await post({ path: folder, name: slug })).json()) as any;
    expect(linked.data.slug).toBe(slug);
    expect(resolveCodingSandboxRoot(slug)).toBe(folder);

    const files = (await (await fetch(`${base}/projects/${slug}/files`)).json()) as any;
    expect(files.data.files.map((f: any) => f.path)).toContain("src/main.ts");

    const list = (await (await fetch(`${base}/projects`)).json()) as any;
    expect(list.data.find((p: any) => p.slug === slug)).toMatchObject({ linked: true, path: folder });

    expect((await post({ path: join(folder, "missing") })).status).toBe(400);
    expect((await post({ path: "relative/dir" })).status).toBe(400);

    const del = (await (await fetch(`${base}/projects/${slug}`, { method: "DELETE" })).json()) as any;
    expect(del.data.unlinked).toBe(true);
    expect(existsSync(join(folder, "src", "main.ts"))).toBe(true);
    expect(readLinkedProjects()[slug]).toBeUndefined();
  });

  it("browses sub-directories and the root list", async () => {
    const base = await startTestServer();
    const listing = (await (await fetch(`${base}/browse?path=${encodeURIComponent(folder)}`)).json()) as any;
    expect(listing.data.path).toBe(folder);
    expect(listing.data.entries.map((e: any) => e.name)).toEqual(["src"]);
    expect(listing.data.parent).toBeTruthy();

    const roots = (await (await fetch(`${base}/browse`)).json()) as any;
    expect(roots.data.entries.length).toBeGreaterThan(0);
    expect((await fetch(`${base}/browse?path=relative`)).status).toBe(400);
  });
});
