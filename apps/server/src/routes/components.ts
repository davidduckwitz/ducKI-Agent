import { Router, type IRouter } from "express";
import { existsSync, statSync } from "node:fs";
import type { DatabaseService } from "@ducki/database";
import {
  COMPONENT_IDS,
  componentSettingKey,
  createApiError,
  createApiResponse,
  getComponentStatuses,
  installComponent,
  assetPackPath,
  isAnyComponentId,
  isAssetPackId,
  isComponentId,
  removeComponentPack,
  setComponentPathOverride,
} from "@ducki/shared";

/** Applies the explicit paths saved in Settings to the resolver (call once at startup). */
export async function loadComponentOverrides(db: DatabaseService): Promise<void> {
  for (const id of COMPONENT_IDS) {
    setComponentPathOverride(id, await db.getSetting(componentSettingKey(id)));
  }
}

export const componentsRouter: IRouter = Router();

componentsRouter.get("/", async (_req, res, next) => {
  try {
    res.json(createApiResponse(await getComponentStatuses()));
  } catch (e) {
    next(e);
  }
});

// Installed asset packs (e.g. Monaco's TypeScript worker) are served to the web UI from here.
componentsRouter.get("/:id/file", (req, res) => {
  const id = req.params["id"];
  const file = isAssetPackId(id) ? assetPackPath(id) : undefined;
  if (!file) return void res.status(404).json(createApiError("Komponente nicht installiert"));
  res.setHeader("Cache-Control", "no-cache");
  res.type("application/javascript").sendFile(file);
});

componentsRouter.post("/:id/install", (req, res) => {
  const id = req.params["id"];
  if (!isAnyComponentId(id)) return void res.status(404).json(createApiError("Unbekannte Komponente"));
  // Fire-and-forget: progress/errors are exposed through GET / (polled by the Settings card).
  installComponent(id).catch(() => {
    /* recorded as installError on the status */
  });
  res.status(202).json(createApiResponse({ started: true }));
});

componentsRouter.put("/:id/path", async (req, res, next) => {
  try {
    const id = req.params["id"];
    if (!isComponentId(id)) return void res.status(404).json(createApiError("Unbekannte Komponente"));
    const db = req.app.locals["db"] as DatabaseService;
    const value = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (value && !(existsSync(value) && statSync(value).isFile())) {
      return void res.status(400).json(createApiError("Datei existiert nicht"));
    }
    if (value) await db.setSetting(componentSettingKey(id), value);
    else await db.deleteSetting(componentSettingKey(id));
    setComponentPathOverride(id, value);
    res.json(createApiResponse(await getComponentStatuses()));
  } catch (e) {
    next(e);
  }
});

componentsRouter.delete("/:id/pack", async (req, res, next) => {
  try {
    const id = req.params["id"];
    if (!isAnyComponentId(id)) return void res.status(404).json(createApiError("Unbekannte Komponente"));
    removeComponentPack(id);
    res.json(createApiResponse(await getComponentStatuses()));
  } catch (e) {
    next(e);
  }
});
