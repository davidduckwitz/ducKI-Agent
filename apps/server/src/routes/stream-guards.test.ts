import express from "express";
import { createServer, get as httpGet, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    // undici (fetch) hält Keep-Alive-Verbindungen offen; ohne das würde server.close()
    // auf deren Timeout warten und der Hook liefe in ein 10s-Timeout.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  vi.resetModules();
});

async function startApp(
  router: express.Router,
  mountPath: string,
  locals: Record<string, unknown> = {}
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  Object.assign(app.locals, locals);
  app.use(mountPath, router);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to acquire test server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => {
      // undici (fetch) hält Keep-Alive-Verbindungen offen; ohne das würde server.close()
      // auf deren Idle-Timeout warten (bis zu 5 s pro Test).
      server.closeAllConnections?.();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("streaming / size-guard routes", () => {
  it("streams the puzzle attempts.csv download (no readFileSync of a huge file)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ducki-csv-"));
    dirs.push(ws);
    const attemptsDir = join(ws, "bitcoin-puzzle-attempts");
    mkdirSync(attemptsDir, { recursive: true });
    // Silences the harmless word-list ENOENT in the service constructor.
    mkdirSync(join(ws, "btc-puzzle"), { recursive: true });
    writeFileSync(join(ws, "btc-puzzle", "english.txt"), "abandon ability able\n", "utf8");

    const id = "puzzle-streamtest";
    writeFileSync(
      join(attemptsDir, `${id}-state.json`),
      JSON.stringify({
        id,
        name: "Stream Test",
        targetAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        status: "paused",
        generatedCount: 3,
        triedCombinationsCount: 3,
        startedAt: new Date().toISOString(),
        lastCheckAt: new Date().toISOString(),
      }),
      "utf8"
    );
    const csvPath = join(attemptsDir, `${id}-attempts.csv`);
    writeFileSync(
      csvPath,
      'mnemonic,address\n"alpha beta gamma delta epsilon zeta eta theta iota kappa 1","addr-1"\n"alpha beta gamma delta epsilon zeta eta theta iota kappa 2","addr-2"\n',
      "utf8"
    );

    process.env["SHARED_WORKSPACE_PATH"] = ws;
    vi.resetModules();
    const { bitcoinPuzzleRouter } = await import("./bitcoin-puzzle.js");
    const server = await startApp(bitcoinPuzzleRouter, "/api/bitcoin-puzzle");

    const res = await fetch(`${server.baseUrl}/api/bitcoin-puzzle/${id}/attempts.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    // Content-Length comes from statSync (the stream source), not from a read string.
    expect(res.headers.get("content-length")).toBe(String(statSync(csvPath).size));
    const body = await res.text();
    expect(body).toContain("mnemonic,address");
    expect(body).toContain("kappa 2");

    // Missing puzzle -> 404, not a crash.
    const missing = await fetch(`${server.baseUrl}/api/bitcoin-puzzle/puzzle-nope/attempts.csv`);
    expect(missing.status).toBe(404);
    await server.close();
  });

  it("answers Range requests with 206 and serves only the requested slice (no full-file stream)", async () => {
    // "815-MB-Äquivalent" für CI: groß genug, dass ein versehentlicher Voll-Stream
    // wehtäte, klein genug für die Testlaufzeit. Das Range-Verhalten ist dasselbe wie
    // bei 815 MB - es wird nur das angeforderte Fenster gelesen.
    const size = 64 * 1024 * 1024; // 64 MB
    const ws = mkdtempSync(join(tmpdir(), "ducki-range-"));
    dirs.push(ws);
    const attemptsDir = join(ws, "bitcoin-puzzle-attempts");
    mkdirSync(attemptsDir, { recursive: true });
    mkdirSync(join(ws, "btc-puzzle"), { recursive: true });
    writeFileSync(join(ws, "btc-puzzle", "english.txt"), "abandon ability able\n", "utf8");

    const id = "puzzle-rangetest";
    writeFileSync(
      join(attemptsDir, `${id}-state.json`),
      JSON.stringify({ id, name: "Range Test", targetAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", status: "paused", generatedCount: 1, triedCombinationsCount: 1 }),
      "utf8"
    );
    const csvPath = join(attemptsDir, `${id}-attempts.csv`);
    const file = Buffer.alloc(size, 0x61); // 'a' * 64 MB
    file.write("mnemonic,address\n", 0, "utf8");
    writeFileSync(csvPath, file);

    process.env["SHARED_WORKSPACE_PATH"] = ws;
    vi.resetModules();
    const { bitcoinPuzzleRouter } = await import("./bitcoin-puzzle.js");
    const server = await startApp(bitcoinPuzzleRouter, "/api/bitcoin-puzzle");
    const url = `${server.baseUrl}/api/bitcoin-puzzle/${id}/attempts.csv`;

    // Präfix-Range: nur die ersten 100 Bytes - der Server darf nicht mehr liefern.
    const prefix = await fetch(url, { headers: { Range: "bytes=0-99" } });
    expect(prefix.status).toBe(206);
    expect(prefix.headers.get("content-range")).toBe(`bytes 0-99/${size}`);
    expect(prefix.headers.get("content-length")).toBe("100");
    const prefixBody = await prefix.arrayBuffer();
    expect(prefixBody.byteLength).toBe(100);
    expect(Buffer.from(prefixBody).toString("utf8")).toContain("mnemonic,address");

    // Mitte der Datei: ein Bereich, der erst NACH den ersten 64 MB liegt.
    const midStart = size - 200;
    const mid = await fetch(url, { headers: { Range: `bytes=${midStart}-${size - 1}` } });
    expect(mid.status).toBe(206);
    expect(mid.headers.get("content-range")).toBe(`bytes ${midStart}-${size - 1}/${size}`);
    expect((await mid.arrayBuffer()).byteLength).toBe(200);

    // Suffix-Range: bytes=-50  ->  die letzten 50 Bytes.
    const suffix = await fetch(url, { headers: { Range: "bytes=-50" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(`bytes ${size - 50}-${size - 1}/${size}`);
    expect((await suffix.arrayBuffer()).byteLength).toBe(50);

    // Nicht erfüllbarer Range -> 416 mit dem tatsächlichen Gesamtumfang.
    const unsat = await fetch(url, { headers: { Range: `bytes=${size + 100}-` } });
    expect(unsat.status).toBe(416);
    expect(unsat.headers.get("content-range")).toBe(`bytes */${size}`);

    // Ohne Range-Header weiterhin der komplette Stream (200).
    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe(String(size));
    await server.close();
  });

  it("aborts the stream cleanly when the client disconnects early (server stays healthy)", async () => {
    const size = 64 * 1024 * 1024;
    const ws = mkdtempSync(join(tmpdir(), "ducki-abort-"));
    dirs.push(ws);
    const attemptsDir = join(ws, "bitcoin-puzzle-attempts");
    mkdirSync(attemptsDir, { recursive: true });
    mkdirSync(join(ws, "btc-puzzle"), { recursive: true });
    writeFileSync(join(ws, "btc-puzzle", "english.txt"), "abandon ability able\n", "utf8");

    const id = "puzzle-aborttest";
    writeFileSync(
      join(attemptsDir, `${id}-state.json`),
      JSON.stringify({ id, name: "Abort Test", targetAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", status: "paused", generatedCount: 1, triedCombinationsCount: 1 }),
      "utf8"
    );
    writeFileSync(join(attemptsDir, `${id}-attempts.csv`), Buffer.alloc(size, 0x62)); // 'b' * 64 MB

    process.env["SHARED_WORKSPACE_PATH"] = ws;
    vi.resetModules();
    const { bitcoinPuzzleRouter } = await import("./bitcoin-puzzle.js");
    const server = await startApp(bitcoinPuzzleRouter, "/api/bitcoin-puzzle");
    const url = `${server.baseUrl}/api/bitcoin-puzzle/${id}/attempts.csv`;

    // Client fordert die Datei an, liest die ersten Bytes und bricht dann die Verbindung ab.
    // Der Server muss den Datei-Stream destruieren (pipe() räumt die Quelle beim
    // Verbindungsende ab), statt die restlichen 64 MB weiter zu lesen.
    await new Promise<void>((resolve, reject) => {
      const req = httpGet(url, { headers: { Range: "bytes=0-99" } }, (res) => {
        expect(res.statusCode).toBe(206);
        res.once("data", () => {
          req.destroy(); // Client hängt auf -> Verbindung wird abgebrochen
          resolve();
        });
        res.on("error", () => resolve());
      });
      req.on("error", () => resolve());
      setTimeout(() => reject(new Error("abort test timed out")), 5000);
    });

    // Der Server muss danach sofort wieder antworten - kein Hänger, keine offene Datei.
    const after = await fetch(url, { headers: { Range: "bytes=0-99" } });
    expect(after.status).toBe(206);
    expect((await after.arrayBuffer()).byteLength).toBe(100);
    await server.close();
  });

  it("shared /read returns 413 for files over the 10 MB inline guard", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ducki-shared-"));
    dirs.push(ws);
    writeFileSync(join(ws, "big.bin"), Buffer.alloc(11 * 1024 * 1024));
    writeFileSync(join(ws, "small.txt"), "hello\n", "utf8");

    process.env["SHARED_WORKSPACE_PATH"] = ws;
    vi.resetModules();
    const { sharedRouter } = await import("./shared.js");
    const server = await startApp(sharedRouter, "/api/shared");

    const big = await fetch(`${server.baseUrl}/api/shared/read?path=big.bin`);
    expect(big.status).toBe(413);
    const bigBody = (await big.json()) as { error?: string };
    expect(bigBody.error ?? "").toContain("zu groß");

    const small = await fetch(`${server.baseUrl}/api/shared/read?path=small.txt`);
    expect(small.status).toBe(200);
    const smallBody = (await small.json()) as { data: { content: string; isText: boolean } };
    expect(smallBody.data.isText).toBe(true);
    expect(smallBody.data.content).toBe("hello\n");
    await server.close();
  });

  it("coding /read returns 413 for files over the 10 MB inline guard", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ducki-coding-"));
    dirs.push(ws);
    const proj = join(ws, "coding", "proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "big.bin"), Buffer.alloc(11 * 1024 * 1024));
    writeFileSync(join(proj, "small.txt"), "ok\n", "utf8");

    process.env["SHARED_WORKSPACE_PATH"] = ws;
    vi.resetModules();
    const { codingRouter } = await import("./coding.js");
    const mockDb = {
      async getSetting(key: string) {
        if (key === "CODING_ENABLED") return "true";
        return undefined;
      },
    };
    const server = await startApp(codingRouter, "/api/coding", { db: mockDb });

    const big = await fetch(`${server.baseUrl}/api/coding/projects/proj/read?path=big.bin`);
    expect(big.status).toBe(413);

    const small = await fetch(`${server.baseUrl}/api/coding/projects/proj/read?path=small.txt`);
    expect(small.status).toBe(200);
    const smallBody = (await small.json()) as { data: { content: string } };
    expect(smallBody.data.content).toBe("ok\n");
    await server.close();
  });

  it("serves plugin UI pages by streaming with content-type and CSP headers", async () => {
    const plugins = mkdtempSync(join(tmpdir(), "ducki-plugins-"));
    dirs.push(plugins);
    const pageDir = join(plugins, "myplug", "ui", "frontend");
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(
      join(plugins, "myplug", "plugin.json"),
      JSON.stringify({
        name: "myplug",
        version: "1.0.0",
        description: "test plugin",
        trust: "sandboxed",
        provides: { frontendPage: "ui/frontend/index.html" },
      }),
      "utf8"
    );
    writeFileSync(join(pageDir, "index.html"), "<html><body>hi</body></html>\n", "utf8");

    process.env["DUCKI_PLUGINS_DIR"] = plugins;
    vi.resetModules();
    const { pluginsRouter } = await import("./plugins.js");
    const server = await startApp(pluginsRouter, "/api/plugins");

    const res = await fetch(`${server.baseUrl}/api/plugins/myplug/ui/frontend`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors");
    const body = await res.text();
    expect(body).toContain("<html>");

    // An asset relative to the page folder streams too.
    writeFileSync(join(pageDir, "app.js"), "console.log('x');\n", "utf8");
    const asset = await fetch(`${server.baseUrl}/api/plugins/myplug/ui/frontend/app.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("console.log");
    await server.close();
  });
});
