import express from "express";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

type Mode = "local" | "cloud";
type Config = { mode: Mode; localUrl: string; cloudUrl: string; apiKey: string; port: number };
type Job = { id: string; status: "pending" | "done" | "failed" | "cancelled"; result?: any; error?: string; createdAt: number; mode?: Mode };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, "data", "config.json");
const defaults: Config = { mode: "local", localUrl: "http://127.0.0.1:3001", cloudUrl: "", apiKey: "", port: 3098 };
const jobs = new Map<string, Job>();

async function loadConfig(): Promise<Config> {
  try { return { ...defaults, ...JSON.parse(await readFile(configPath, "utf8")) }; } catch { return defaults; }
}

async function hasSavedConfig(): Promise<boolean> {
  try { await access(configPath); return true; } catch { return false; }
}

async function saveConfig(config: Config): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(configPath, 0o600).catch(() => undefined);
}

function cleanUrl(url: string): string { return url.trim().replace(/\/+$/, ""); }

async function jsonFetch(url: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(body?.message || body?.error || `HTTP ${response.status}: ${String(text).slice(0, 240)}`);
  return body?.data ?? body;
}

async function cloudToken(config: Config): Promise<string> {
  const body = await jsonFetch(`${cleanUrl(config.cloudUrl)}/api/token`, {
    method: "POST", body: JSON.stringify({ key: config.apiKey }),
  });
  const token = body?.access_token;
  if (!token) throw new Error("Laravel hat kein Zugriffstoken geliefert.");
  return token;
}

async function cloudRequest(config: Config, path: string, init: RequestInit = {}): Promise<any> {
  const token = await cloudToken(config);
  return jsonFetch(`${cleanUrl(config.cloudUrl)}${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

async function queueCloud(config: Config, type: string, payload: Record<string, unknown>): Promise<any> {
  const command = await cloudRequest(config, "/api/agent/voice/client/commands", {
    method: "POST", body: JSON.stringify({ type, payload }),
  });
  const deadline = Date.now() + 65 * 60_000;
  while (Date.now() < deadline) {
    const current = await cloudRequest(config, `/api/agent/voice/client/commands/${command.id}`);
    if (current.status === "done") return current.result ?? {};
    if (current.status === "failed") throw new Error(current.result?.error || "Agent-Auftrag fehlgeschlagen.");
    await new Promise(resolveWait => setTimeout(resolveWait, 1800));
  }
  throw new Error("Der Auftrag läuft länger als 65 Minuten.");
}

async function localModels(config: Config): Promise<any> {
  const response = await jsonFetch(`${cleanUrl(config.localUrl)}/api/provider-models/active`);
  return (response.models ?? []).map((model: any) => ({ ...model, provider: response.providerName }));
}

async function uploadLocal(config: Config, attachment: any): Promise<string> {
  const uploaded = await jsonFetch(`${cleanUrl(config.localUrl)}/api/shared/upload`, {
    method: "POST",
    body: JSON.stringify({ fileName: attachment.name, contentBase64: attachment.base64, folder: "chat-uploads/erpel" }),
  });
  return uploaded.path;
}

async function runChat(config: Config, input: any): Promise<any> {
  const type = input.mode === "team" ? "bot.chat.send" : "chat.send";
  if (config.mode === "cloud") {
    return queueCloud(config, type, {
      message: input.message, conversationId: input.conversationId || undefined, model: input.model || undefined,
      ...(input.attachment ? { attachment: input.attachment.base64, attachmentName: input.attachment.name, attachmentMimeType: input.attachment.mimeType } : {}),
    });
  }
  let message = String(input.message ?? "").trim();
  if (input.attachment) {
    const path = await uploadLocal(config, input.attachment);
    message = `${message}\n\nAngehängte Datei: ${path}\nBitte analysiere diese Datei.`.trim();
  }
  if (input.mode === "team") {
    return jsonFetch(`${cleanUrl(config.localUrl)}/api/bots/main/chat`, { method: "POST", body: JSON.stringify({ message }) });
  }
  return jsonFetch(`${cleanUrl(config.localUrl)}/api/chat`, {
    method: "POST", body: JSON.stringify({ message, conversationId: input.conversationId || undefined, model: input.model || undefined, clientRunId: input.clientRunId }),
  });
}

async function startJob(task: (job: Job) => Promise<any>): Promise<Job> {
  const job: Job = { id: randomUUID(), status: "pending", createdAt: Date.now() };
  jobs.set(job.id, job);
  void task(job).then(result => { if (job.status === "pending") Object.assign(job, { status: "done", result }); }).catch(error => { if (job.status === "pending") Object.assign(job, {
    status: "failed", error: error instanceof Error ? error.message : String(error),
  }); });
  return job;
}

const app = express();
app.use(express.json({ limit: "55mb" }));

app.get("/erpel-api/config", async (_req, res) => {
  const config = await loadConfig();
  res.json({ configured: await hasSavedConfig(), config: { ...config, apiKey: config.apiKey ? "••••••••" : "" } });
});

app.post("/erpel-api/setup/test", async (req, res, next) => {
  try {
    const current = await loadConfig();
    const config = { ...current, ...req.body, apiKey: req.body.apiKey?.trim() || current.apiKey, localUrl: cleanUrl(req.body.localUrl ?? current.localUrl), cloudUrl: cleanUrl(req.body.cloudUrl ?? current.cloudUrl) } as Config;
    if (config.mode === "local") await jsonFetch(`${config.localUrl}/api/provider-models`);
    else await cloudToken(config);
    res.json({ ok: true });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/erpel-api/setup", async (req, res, next) => {
  try {
    const current = await loadConfig();
    const config: Config = { ...current, ...req.body, apiKey: req.body.apiKey?.trim() || current.apiKey, localUrl: cleanUrl(req.body.localUrl ?? current.localUrl), cloudUrl: cleanUrl(req.body.cloudUrl ?? current.cloudUrl) };
    if (config.mode === "local") await jsonFetch(`${config.localUrl}/api/provider-models`); else await cloudToken(config);
    await saveConfig(config);
    res.json({ ok: true, config: { ...config, apiKey: config.apiKey ? "••••••••" : "" } });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.get("/erpel-api/models", async (_req, res, next) => {
  try { const config = await loadConfig(); res.json(config.mode === "cloud" ? await queueCloud(config, "voice.models", {}) : { models: await localModels(config) }); }
  catch (error) { next(error); }
});

app.get("/erpel-api/bots", async (_req, res, next) => {
  try {
    const config = await loadConfig();
    const result = config.mode === "cloud" ? await queueCloud(config, "voice.bots", {}) : { bots: await jsonFetch(`${config.localUrl}/api/bots`) };
    let petId: string | null = null;
    try { petId = (await jsonFetch(`${cleanUrl(config.localUrl)}/api/settings/ERPEL_PET_ID`)).value ?? null; } catch { /* Cloud-only Erpel may not reach the local agent directly. */ }
    res.json({ ...result, petId });
  } catch (error) { next(error); }
});

app.get("/erpel-api/agent-asset", async (req, res, next) => {
  try {
    const path = String(req.query["path"] ?? "");
    if (!path.startsWith("/api/shared/") && !path.startsWith("/api/artifacts/")) return res.status(400).json({ error: "Ungültiger Agent-Asset-Pfad." });
    const config = await loadConfig();
    const response = await fetch(`${cleanUrl(config.localUrl)}${path}`);
    if (!response.ok || !response.body) throw new Error(`Agent-Asset nicht verfügbar (HTTP ${response.status}).`);
    res.status(response.status);
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=300");
    const bytes = Buffer.from(await response.arrayBuffer());
    res.send(bytes);
  } catch (error) { next(error); }
});

app.post("/erpel-api/chat", async (req, res) => res.status(202).json(await startJob(async job => {
  const config = await loadConfig(); job.mode = config.mode;
  return runChat(config, { ...req.body, clientRunId: job.id });
})));

app.post("/erpel-api/transcribe", async (req, res) => {
  const body = req.body;
  res.status(202).json(await startJob(async job => {
    const config = await loadConfig();
    job.mode = config.mode;
    if (config.mode === "cloud") return queueCloud(config, "voice.transcribe", { audio: body.audio, mode: body.mode, model: body.model || undefined, conversationId: body.conversationId || undefined });
    const transcript = await jsonFetch(`${config.localUrl}/api/chat/transcribe`, { method: "POST", body: JSON.stringify({ audio: body.audio }) });
    const result = await runChat(config, { ...body, message: transcript.text, clientRunId: job.id });
    return { ...result, transcript: transcript.text };
  }));
});

app.get("/erpel-api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Auftrag nicht gefunden." });
  res.json(job);
});

app.post("/erpel-api/jobs/:id/stop", async (req, res, next) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Auftrag nicht gefunden." });
    if (job.status !== "pending") return res.json(job);
    const config = await loadConfig();
    if (config.mode === "local") {
      let run: any = null;
      for (let attempt = 0; attempt < 6 && !run; attempt++) {
        const live = await jsonFetch(`${cleanUrl(config.localUrl)}/api/agents/live`);
        run = (live.agents ?? []).find((entry: any) => entry.label === `Erpel:${job.id}`);
        if (!run) await new Promise(resolveWait => setTimeout(resolveWait, 150));
      }
      if (run) await jsonFetch(`${cleanUrl(config.localUrl)}/api/agents/live/${encodeURIComponent(run.id)}/stop`, { method: "POST" });
    }
    job.status = "cancelled";
    job.error = config.mode === "cloud" ? "Warten beendet. Der Cloud-Agent kann den bereits laufenden Auftrag noch abschließen." : "Vom Benutzer gestoppt.";
    res.json(job);
  } catch (error) { next(error); }
});

app.use("/erpel-api", (_req, res) => res.status(404).json({ error: "Unbekannter Erpel-Endpunkt." }));
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error?.message || "Interner Fehler" }));
app.use(express.static(resolve(root, "dist")));
app.get("*", (_req, res) => res.sendFile(resolve(root, "dist", "index.html")));

const initial = await loadConfig();
app.listen(Number(process.env["ERPEL_PORT"] ?? initial.port), process.env["ERPEL_HOST"] ?? "127.0.0.1", () => {
  console.log(`Erpel läuft auf http://${process.env["ERPEL_HOST"] ?? "127.0.0.1"}:${process.env["ERPEL_PORT"] ?? initial.port}`);
});
