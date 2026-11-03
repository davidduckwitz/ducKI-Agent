import { Router, type IRouter } from "express";
import type { DatabaseService } from "@ducki/database";
import { createApiError, createApiResponse } from "@ducki/shared";
import { SECRET_PRESETS, deleteSecret, getSecret, listSecrets, setSecret } from "../lib/secrets-store.js";

export const secretsRouter: IRouter = Router();

const fail = (res: import("express").Response, error: unknown, status = 400) =>
  res.status(status).json(createApiError(error instanceof Error ? error.message : String(error)));

secretsRouter.get("/", async (req, res, next) => {
  try { res.json(createApiResponse({ secrets: await listSecrets(req.app.locals["db"] as DatabaseService), presets: SECRET_PRESETS })); }
  catch (error) { next(error); }
});

secretsRouter.put("/:name", async (req, res) => {
  try {
    const body = req.body as { value?: unknown; label?: unknown };
    await setSecret(req.app.locals["db"] as DatabaseService, String(req.params["name"] ?? ""),
      typeof body?.value === "string" ? body.value : "", typeof body?.label === "string" ? body.label : undefined);
    res.json(createApiResponse({ saved: true }));
  } catch (error) { fail(res, error); }
});

secretsRouter.delete("/:name", async (req, res) => {
  try {
    await deleteSecret(req.app.locals["db"] as DatabaseService, String(req.params["name"] ?? ""));
    res.json(createApiResponse({ deleted: true }));
  } catch (error) { fail(res, error); }
});

/** Verifies a stored Hugging Face token against huggingface.co (only on explicit user click). */
secretsRouter.post("/HF_TOKEN/test", async (req, res) => {
  try {
    const token = await getSecret(req.app.locals["db"] as DatabaseService, "HF_TOKEN");
    if (!token) return void fail(res, new Error("Kein Hugging-Face-Token hinterlegt."), 404);
    const response = await fetch("https://huggingface.co/api/whoami-v2", {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return void fail(res, new Error(response.status === 401 ? "Token ungültig oder abgelaufen (401)." : `Hugging Face antwortete mit HTTP ${response.status}.`), 400);
    const body = await response.json() as { name?: string; type?: string };
    res.json(createApiResponse({ ok: true, user: body.name, type: body.type }));
  } catch (error) { fail(res, error, 502); }
});
