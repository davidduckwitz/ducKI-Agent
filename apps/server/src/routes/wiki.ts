import { Router, type IRouter } from "express";
import type { DatabaseService } from "@ducki/database";
import { createApiError, createApiResponse } from "@ducki/shared";
import { aggregateWikiNotes, deriveFolderStructure, type LlmWikiService } from "../lib/llm-wiki-service.js";

export const wikiRouter: IRouter = Router();

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

wikiRouter.get("/status", async (req, res) => {
  const db = req.app.locals["db"] as DatabaseService;
  const wiki = req.app.locals["wikiService"] as LlmWikiService | undefined;

  const setting = await db.getSetting("WIKI_ENABLED");
  const enabled = parseBoolean(setting ?? process.env["WIKI_ENABLED"], false);
  const autoMemory = parseBoolean((await db.getSetting("WIKI_SHARED_SOURCE_AUTO_MEMORY")) ?? "true", true);
  const autoApprove = parseBoolean((await db.getSetting("WIKI_AUTO_APPROVE")) ?? "false", false);
  const maxFileSizeKb = Number.parseInt((await db.getSetting("WIKI_SHARED_SOURCE_MAX_FILE_SIZE_KB")) ?? "256", 10);
  const intervalMs = Number.parseInt((await db.getSetting("WIKI_INGEST_INTERVAL_MS")) ?? "30000", 10);
  const chunkSizeChars = Number.parseInt((await db.getSetting("WIKI_CHUNK_SIZE_CHARS")) ?? "1400", 10);
  const chunkOverlapChars = Number.parseInt((await db.getSetting("WIKI_CHUNK_OVERLAP_CHARS")) ?? "200", 10);
  const sourcePath = ((await db.getSetting("WIKI_SHARED_SOURCE_PATH")) ?? process.env["WIKI_SHARED_SOURCE_PATH"] ?? "llm-wiki").trim();

  res.json(createApiResponse({
    enabled,
    config: {
      sourcePath,
      autoMemory,
      autoApprove,
      maxFileSizeKb,
      intervalMs,
      chunkSizeChars,
      chunkOverlapChars,
    },
    stats: wiki?.getStats() ?? null,
  }));
});

wikiRouter.get("/entries", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const wiki = req.app.locals["wikiService"] as LlmWikiService | undefined;
    if (!wiki) {
      res.status(503).json(createApiError("Wiki service unavailable"));
      return;
    }
    const limit = req.query["limit"] ? Number(req.query["limit"]) : 200;
    const status = req.query["status"] ? String(req.query["status"]) : undefined;
    const entries = await wiki.listEntries(limit, status);
    res.json(createApiResponse(entries));
  } catch (error) {
    next(error);
  }
});

wikiRouter.get("/search", async (req, res, next) => {
  try {
    const wiki = req.app.locals["wikiService"] as LlmWikiService | undefined;
    if (!wiki) {
      res.status(503).json(createApiError("Wiki service unavailable"));
      return;
    }

    const query = String(req.query["query"] ?? "").trim();
    if (!query) {
      res.status(400).json(createApiError("query is required"));
      return;
    }

    const limit = req.query["limit"] ? Number(req.query["limit"]) : 20;
    const includeCandidates = String(req.query["includeCandidates"] ?? "false").toLowerCase() === "true";
    const results = await wiki.search(query, limit, includeCandidates);
    res.json(createApiResponse(results));
  } catch (error) {
    next(error);
  }
});

wikiRouter.post("/reindex", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const wiki = req.app.locals["wikiService"] as LlmWikiService | undefined;
    if (!wiki) {
      res.status(503).json(createApiError("Wiki service unavailable"));
      return;
    }

    const setting = await db.getSetting("WIKI_ENABLED");
    const enabled = parseBoolean(setting ?? process.env["WIKI_ENABLED"], false);
    if (!enabled) {
      res.status(400).json(createApiError("Wiki is disabled (WIKI_ENABLED=false)"));
      return;
    }

    const stats = await wiki.ingestNow();
    res.json(createApiResponse({ reindexed: true, stats }));
  } catch (error) {
    next(error);
  }
});

wikiRouter.put("/config", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const wiki = req.app.locals["wikiService"] as LlmWikiService | undefined;
    const enabled = req.body?.enabled;
    const autoMemory = req.body?.autoMemory;
    const autoApprove = req.body?.autoApprove;
    const maxFileSizeKb = req.body?.maxFileSizeKb;
    const intervalMs = req.body?.intervalMs;
    const chunkSizeChars = req.body?.chunkSizeChars;
    const chunkOverlapChars = req.body?.chunkOverlapChars;
    const sourcePath = req.body?.sourcePath;

    if (enabled !== undefined) await db.setSetting("WIKI_ENABLED", String(Boolean(enabled)));
    if (autoMemory !== undefined) await db.setSetting("WIKI_SHARED_SOURCE_AUTO_MEMORY", String(Boolean(autoMemory)));
    if (autoApprove !== undefined) await db.setSetting("WIKI_AUTO_APPROVE", String(Boolean(autoApprove)));
    if (maxFileSizeKb !== undefined) await db.setSetting("WIKI_SHARED_SOURCE_MAX_FILE_SIZE_KB", String(Number(maxFileSizeKb)));
    if (intervalMs !== undefined) await db.setSetting("WIKI_INGEST_INTERVAL_MS", String(Number(intervalMs)));
    if (chunkSizeChars !== undefined) await db.setSetting("WIKI_CHUNK_SIZE_CHARS", String(Number(chunkSizeChars)));
    if (chunkOverlapChars !== undefined) await db.setSetting("WIKI_CHUNK_OVERLAP_CHARS", String(Number(chunkOverlapChars)));
    if (sourcePath !== undefined) {
      const trimmed = String(sourcePath).trim();
      if (trimmed.includes("..")) {
        res.status(400).json(createApiError("sourcePath must not contain '..'"));
        return;
      }
      await db.setSetting("WIKI_SHARED_SOURCE_PATH", trimmed || "llm-wiki");
    }

    if (enabled === true && wiki) {
      await wiki.ingestNow();
    }

    res.json(createApiResponse({ saved: true }));
  } catch (error) {
    next(error);
  }
});

wikiRouter.post("/entries/:id/approve", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const wiki = req.app.locals["wikiService"] as LlmWikiService | undefined;
    if (!wiki) {
      res.status(503).json(createApiError("Wiki service unavailable"));
      return;
    }

    const enabled = parseBoolean((await db.getSetting("WIKI_ENABLED")) ?? process.env["WIKI_ENABLED"], false);
    if (!enabled) {
      res.status(400).json(createApiError("Wiki is disabled (WIKI_ENABLED=false)"));
      return;
    }

    const id = Number(req.params["id"]);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(createApiError("Invalid entry id"));
      return;
    }

    const result = await wiki.setEntryStatus(id, "approved");
    res.json(createApiResponse({ approved: true, ...result }));
  } catch (error) {
    next(error);
  }
});

wikiRouter.get("/graph", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;

    const entries = await db.listLlmWikiEntries(3000);
    const links = await db.listLlmWikiLinks("active");

    // Entries are stored per chunk (sourceFile#chunk-N); the graph is note-level, so
    // fold chunks back down to one node per source file - same reduction used by
    // LlmWikiService.expand(), so /graph and /expand agree on what a "node" is.
    const noteNodes = aggregateWikiNotes(entries);
    const { folderNodes, folderEdges } = deriveFolderStructure(noteNodes);
    const nodesByFile = new Map([...noteNodes, ...folderNodes].map((note) => [note.id, { ...note, degree: 0 }]));

    const edges = [
      ...links.map((link) => ({
        id: link.id as number | string,
        source: link.sourceFile,
        target: link.targetFile ?? link.targetRaw,
        origin: link.origin as "parsed" | "manual" | "folder",
        resolved: Boolean(link.targetFile),
      })),
      ...folderEdges.map((edge) => ({
        id: `folder:${edge.source}->${edge.target}`,
        source: edge.source,
        target: edge.target,
        origin: "folder" as const,
        resolved: true,
      })),
    ];

    for (const edge of edges) {
      const sourceNode = nodesByFile.get(edge.source);
      if (sourceNode) sourceNode.degree += 1;
      if (edge.resolved) {
        const targetNode = nodesByFile.get(edge.target);
        if (targetNode) targetNode.degree += 1;
      }
    }

    res.json(createApiResponse({ nodes: Array.from(nodesByFile.values()), edges }));
  } catch (error) {
    next(error);
  }
});

wikiRouter.get("/expand", async (req, res, next) => {
  try {
    const wiki = req.app.locals["wikiService"] as LlmWikiService | undefined;
    if (!wiki) {
      res.status(503).json(createApiError("Wiki service unavailable"));
      return;
    }

    const query = req.query["query"] !== undefined ? String(req.query["query"]) : undefined;
    const seedIdsRaw = req.query["seedIds"];
    const seedIds = seedIdsRaw !== undefined ? String(seedIdsRaw).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    if (!query?.trim() && (!seedIds || seedIds.length === 0)) {
      res.status(400).json(createApiError("query or seedIds is required"));
      return;
    }

    const maxHops = req.query["maxHops"] ? Number(req.query["maxHops"]) : undefined;
    const maxNodes = req.query["maxNodes"] ? Number(req.query["maxNodes"]) : undefined;

    const nodes = await wiki.expand({ query, seedIds, maxHops, maxNodes });
    res.json(createApiResponse({ nodes }));
  } catch (error) {
    next(error);
  }
});

wikiRouter.post("/links", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const sourceFile = String(req.body?.sourceFile ?? "").trim();
    const targetFile = String(req.body?.targetFile ?? "").trim();
    if (!sourceFile || !targetFile) {
      res.status(400).json(createApiError("sourceFile and targetFile are required"));
      return;
    }
    const link = await db.createManualLink(sourceFile, targetFile);
    res.json(createApiResponse(link));
  } catch (error) {
    next(error);
  }
});

wikiRouter.delete("/links/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(createApiError("Invalid link id"));
      return;
    }
    const link = await db.removeLlmWikiLink(id);
    if (!link) {
      res.status(404).json(createApiError("Link not found"));
      return;
    }
    res.json(createApiResponse({ removed: true, id: link.id }));
  } catch (error) {
    next(error);
  }
});

wikiRouter.post("/entries/:id/reject", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const wiki = req.app.locals["wikiService"] as LlmWikiService | undefined;
    if (!wiki) {
      res.status(503).json(createApiError("Wiki service unavailable"));
      return;
    }

    const enabled = parseBoolean((await db.getSetting("WIKI_ENABLED")) ?? process.env["WIKI_ENABLED"], false);
    if (!enabled) {
      res.status(400).json(createApiError("Wiki is disabled (WIKI_ENABLED=false)"));
      return;
    }

    const id = Number(req.params["id"]);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(createApiError("Invalid entry id"));
      return;
    }

    const result = await wiki.setEntryStatus(id, "rejected");
    res.json(createApiResponse({ rejected: true, ...result }));
  } catch (error) {
    next(error);
  }
});
