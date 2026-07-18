import { Router, type IRouter } from "express";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse } from "@ducki/shared";

export const memoryRouter: IRouter = Router();

const AGENT_BEHAVIOR_PREFIX = "[PROFILE:AGENT_BEHAVIOR]";
const HUMAN_INFO_PREFIX = "[PROFILE:HUMAN_INFO]";

function prefixedContent(prefix: string, content: string): string {
  return `${prefix} ${content.trim()}`.trim();
}

function extractPrefixed(content: string, prefix: string): string {
  return content.startsWith(prefix) ? content.slice(prefix.length).trim() : "";
}

async function findByPrefix(db: DatabaseService, type: string, prefix: string) {
  const entries = await db.getMemories(undefined, type);
  return entries.filter((entry) => entry.content.startsWith(prefix));
}

async function upsertProfileEntry(
  db: DatabaseService,
  type: "long-term" | "semantic",
  prefix: string,
  content: string,
  importance: number
): Promise<void> {
  const existing = await findByPrefix(db, type, prefix);
  for (const entry of existing) {
    await db.deleteMemory(entry.id);
  }
  const normalized = content.trim();
  if (!normalized) return;
  await db.addMemory({
    type,
    content: prefixedContent(prefix, normalized),
    importance,
  });
}

memoryRouter.get("/", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const conversationId = req.query["conversationId"] ? parseInt(req.query["conversationId"] as string) : undefined;
    const type = req.query["type"] as string | undefined;
    res.json(createApiResponse(await db.getMemories(conversationId, type)));
  } catch (e) { next(e); }
});

memoryRouter.delete("/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const id = Number.parseInt(String(req.params["id"] ?? ""), 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ success: false, error: "Valid memory id is required", timestamp: new Date().toISOString() });
      return;
    }

    const existing = await db.getMemories();
    const match = existing.find((entry) => entry.id === id);
    if (!match) {
      res.status(404).json({ success: false, error: `Memory with id ${id} not found`, timestamp: new Date().toISOString() });
      return;
    }

    await db.deleteMemory(id);
    res.json(createApiResponse({ deleted: true, id }));
  } catch (e) { next(e); }
});

memoryRouter.post("/actions", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const action = String(req.body?.action ?? "").toLowerCase();
    const type = String(req.body?.type ?? "long-term").toLowerCase();
    const conversationId = req.body?.conversationId !== undefined ? Number(req.body.conversationId) : undefined;
    const scopeConversationId = Number.isFinite(conversationId) ? conversationId : undefined;

    if (!action) {
      res.status(400).json({ success: false, error: "action is required", timestamp: new Date().toISOString() });
      return;
    }

    if (action === "add") {
      const content = String(req.body?.content ?? "").trim();
      if (!content) {
        res.status(400).json({ success: false, error: "content is required", timestamp: new Date().toISOString() });
        return;
      }
      const importanceRaw = Number(req.body?.importance ?? 5);
      const importance = Number.isFinite(importanceRaw) ? Math.max(1, Math.min(10, Math.floor(importanceRaw))) : 5;
      const created = await db.addMemory({ type, content, importance, conversationId: scopeConversationId });
      res.json(createApiResponse(created));
      return;
    }

    if (action === "replace") {
      const oldText = String(req.body?.oldText ?? "").trim();
      const content = String(req.body?.content ?? "").trim();
      if (!oldText || !content) {
        res.status(400).json({ success: false, error: "oldText and content are required", timestamp: new Date().toISOString() });
        return;
      }
      const entries = await db.getMemories(scopeConversationId, type);
      const matches = entries.filter((entry) => entry.content.includes(oldText));
      if (matches.length === 0) {
        res.status(404).json({ success: false, error: `No memory matched '${oldText}'`, timestamp: new Date().toISOString() });
        return;
      }
      if (new Set(matches.map((entry) => entry.content)).size > 1) {
        res.status(400).json({ success: false, error: `oldText '${oldText}' matched multiple memories`, timestamp: new Date().toISOString() });
        return;
      }
      const match = matches[0];
      if (!match) {
        res.status(404).json({ success: false, error: `No memory matched '${oldText}'`, timestamp: new Date().toISOString() });
        return;
      }
      await db.deleteMemory(match.id);
      const created = await db.addMemory({
        type: match.type,
        content,
        importance: match.importance,
        conversationId: match.conversationId ?? scopeConversationId,
      });
      res.json(createApiResponse({ replacedByNewEntry: true, previousId: match.id, newEntry: created }));
      return;
    }

    if (action === "remove") {
      const oldText = String(req.body?.oldText ?? "").trim();
      if (!oldText) {
        res.status(400).json({ success: false, error: "oldText is required", timestamp: new Date().toISOString() });
        return;
      }
      const entries = await db.getMemories(scopeConversationId, type);
      const matches = entries.filter((entry) => entry.content.includes(oldText));
      if (matches.length === 0) {
        res.status(404).json({ success: false, error: `No memory matched '${oldText}'`, timestamp: new Date().toISOString() });
        return;
      }
      if (new Set(matches.map((entry) => entry.content)).size > 1) {
        res.status(400).json({ success: false, error: `oldText '${oldText}' matched multiple memories`, timestamp: new Date().toISOString() });
        return;
      }
      const match = matches[0];
      if (!match) {
        res.status(404).json({ success: false, error: `No memory matched '${oldText}'`, timestamp: new Date().toISOString() });
        return;
      }
      await db.deleteMemory(match.id);
      res.json(createApiResponse({ removed: true, id: match.id }));
      return;
    }

    if (action === "batch") {
      const operations = Array.isArray(req.body?.operations) ? req.body.operations : [];
      if (operations.length === 0) {
        res.status(400).json({ success: false, error: "operations[] is required", timestamp: new Date().toISOString() });
        return;
      }

      const results: unknown[] = [];
      for (const rawOp of operations) {
        const op = (rawOp ?? {}) as Record<string, unknown>;
        const opAction = String(op["action"] ?? "").toLowerCase();
        if (opAction === "add") {
          const content = String(op["content"] ?? "").trim();
          if (!content) throw new Error("batch add requires content");
          const created = await db.addMemory({
            type,
            content,
            importance: 5,
            conversationId: scopeConversationId,
          });
          results.push({ action: opAction, entry: created });
          continue;
        }

        if (opAction === "replace" || opAction === "remove") {
          const oldText = String(op["oldText"] ?? "").trim();
          if (!oldText) throw new Error(`batch ${opAction} requires oldText`);
          const entries = await db.getMemories(scopeConversationId, type);
          const matches = entries.filter((entry) => entry.content.includes(oldText));
          if (matches.length === 0) throw new Error(`batch ${opAction}: no match for '${oldText}'`);
          if (new Set(matches.map((entry) => entry.content)).size > 1) {
            throw new Error(`batch ${opAction}: '${oldText}' matched multiple memories`);
          }
          const match = matches[0];
          if (!match) throw new Error(`batch ${opAction}: no match for '${oldText}'`);
          await db.deleteMemory(match.id);

          if (opAction === "replace") {
            const content = String(op["content"] ?? "").trim();
            if (!content) throw new Error("batch replace requires content");
            const created = await db.addMemory({
              type: match.type,
              content,
              importance: match.importance,
              conversationId: match.conversationId ?? scopeConversationId,
            });
            results.push({ action: opAction, previousId: match.id, newEntry: created });
          } else {
            results.push({ action: opAction, removedId: match.id });
          }
          continue;
        }

        throw new Error(`Unknown batch operation '${opAction}'`);
      }

      res.json(createApiResponse({ applied: results.length, results }));
      return;
    }

    res.status(400).json({ success: false, error: `Unknown action '${action}'`, timestamp: new Date().toISOString() });
  } catch (e) { next(e); }
});

memoryRouter.get("/profile", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const [agentEntries, humanEntries] = await Promise.all([
      findByPrefix(db, "long-term", AGENT_BEHAVIOR_PREFIX),
      findByPrefix(db, "semantic", HUMAN_INFO_PREFIX),
    ]);

    const latestAgent = agentEntries.sort((a, b) => b.id - a.id)[0];
    const latestHuman = humanEntries.sort((a, b) => b.id - a.id)[0];

    res.json(createApiResponse({
      agentBehavior: latestAgent ? extractPrefixed(latestAgent.content, AGENT_BEHAVIOR_PREFIX) : "",
      humanInfo: latestHuman ? extractPrefixed(latestHuman.content, HUMAN_INFO_PREFIX) : "",
    }));
  } catch (e) { next(e); }
});

memoryRouter.put("/profile", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const agentBehavior = String(req.body?.agentBehavior ?? "").trim();
    const humanInfo = String(req.body?.humanInfo ?? "").trim();

    await upsertProfileEntry(db, "long-term", AGENT_BEHAVIOR_PREFIX, agentBehavior, 9);
    await upsertProfileEntry(db, "semantic", HUMAN_INFO_PREFIX, humanInfo, 9);

    res.json(createApiResponse({ saved: true, agentBehavior, humanInfo }));
  } catch (e) { next(e); }
});


