import { Router, type IRouter } from "express";
import { createApiError, createApiResponse } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { SHARED_WORKSPACE_ROOT, CODING_WORKSPACE_ROOT } from "@ducki/tools";
import { listCheckpoints, diffCheckpoint, restoreCheckpoint } from "@ducki/agent";

export const codingRouter: IRouter = Router();

const SHARED_ROOT = SHARED_WORKSPACE_ROOT;
export const CODING_ROOT = CODING_WORKSPACE_ROOT;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".ts", ".tsx", ".js", ".jsx", ".py", ".yml", ".yaml", ".xml", ".csv", ".html", ".css",
]);

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function ensureCodingRoot(): void {
  if (!existsSync(CODING_ROOT)) mkdirSync(CODING_ROOT, { recursive: true });
}

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  if (!normalized) return "";
  if (normalized.includes("..")) {
    throw new Error("Path traversal is not allowed");
  }
  return normalized;
}

function projectRoot(project: string): { slug: string; absolute: string } {
  const slug = sanitizeSegment(project);
  if (!slug) {
    throw new Error("Invalid project name");
  }
  const abs = resolve(CODING_ROOT, slug);
  if (!abs.startsWith(CODING_ROOT)) {
    throw new Error("Project path escapes coding root");
  }
  return { slug, absolute: abs };
}

function absoluteFromProjectRelative(projectAbsRoot: string, relativePath: string): string {
  const clean = sanitizeRelativePath(relativePath);
  const abs = resolve(projectAbsRoot, clean);
  if (!abs.startsWith(projectAbsRoot)) {
    throw new Error("Path escapes project root");
  }
  return abs;
}

/** Never surfaced in the project's file tree: machinery (the checkpoint store), dependencies,
 *  and build output. Listing them recursively is also what made the tree slow to load on any
 *  project that had ever run `npm install`. */
const HIDDEN_PROJECT_DIRS = new Set([
  ".ducki-checkpoints",
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
]);

function listRecursive(root: string, relativePrefix = ""): Array<{ path: string; type: "file" | "directory"; size?: number; updatedAt?: string }> {
  const entries = readdirSync(root, { withFileTypes: true });
  const out: Array<{ path: string; type: "file" | "directory"; size?: number; updatedAt?: string }> = [];

  for (const entry of entries) {
    const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const absPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (HIDDEN_PROJECT_DIRS.has(entry.name)) continue;
      out.push({ path: relPath, type: "directory" });
      out.push(...listRecursive(absPath, relPath));
      continue;
    }

    const st = statSync(absPath);
    out.push({
      path: relPath,
      type: "file",
      size: st.size,
      updatedAt: st.mtime.toISOString(),
    });
  }

  return out;
}

codingRouter.use(async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const raw = await db.getSetting("CODING_ENABLED");
    const enabled = parseBoolean(raw ?? "false", false);
    if (!enabled) {
      res.status(403).json(createApiError("Coding area is disabled"));
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
});

codingRouter.get("/status", (_req, res) => {
  ensureCodingRoot();
  res.json(createApiResponse({ enabled: true, root: "coding" }));
});

codingRouter.get("/projects", (_req, res) => {
  ensureCodingRoot();
  const dirs = readdirSync(CODING_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ slug: entry.name, name: entry.name }));
  res.json(createApiResponse(dirs));
});

codingRouter.post("/projects", (req, res) => {
  try {
    ensureCodingRoot();
    const name = String(req.body?.name ?? "");
    const { slug, absolute } = projectRoot(name);
    if (!existsSync(absolute)) mkdirSync(absolute, { recursive: true });
    res.json(createApiResponse({ created: true, slug, path: `coding/${slug}` }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

codingRouter.get("/projects/:project/files", (req, res) => {
  try {
    ensureCodingRoot();
    const { slug, absolute } = projectRoot(String(req.params["project"] ?? ""));
    if (!existsSync(absolute)) {
      res.status(404).json(createApiError("Project not found"));
      return;
    }
    const files = listRecursive(absolute);
    res.json(createApiResponse({ project: slug, files }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

codingRouter.get("/projects/:project/read", (req, res) => {
  try {
    ensureCodingRoot();
    const rel = String(req.query["path"] ?? "");
    if (!rel) {
      res.status(400).json(createApiError("path query parameter is required"));
      return;
    }

    const { slug, absolute } = projectRoot(String(req.params["project"] ?? ""));
    if (!existsSync(absolute)) {
      res.status(404).json(createApiError("Project not found"));
      return;
    }

    const target = absoluteFromProjectRelative(absolute, rel);
    if (!existsSync(target)) {
      res.status(404).json(createApiError("File not found"));
      return;
    }

    const ext = extname(target).toLowerCase();
    const buffer = readFileSync(target);
    const isText = TEXT_EXTENSIONS.has(ext);
    res.json(createApiResponse({
      project: slug,
      path: sanitizeRelativePath(rel),
      size: buffer.length,
      isText,
      content: isText ? buffer.toString("utf8") : undefined,
      contentBase64: !isText ? buffer.toString("base64") : undefined,
    }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

codingRouter.post("/projects/:project/write", (req, res) => {
  try {
    ensureCodingRoot();
    const rel = String(req.body?.path ?? "");
    if (!rel) {
      res.status(400).json(createApiError("path is required"));
      return;
    }
    const content = String(req.body?.content ?? "");
    const expectedSize = req.body?.expectedSize as number | undefined;

    // Detect truncation from LLM token limits
    const warnings: string[] = [];

    // Check for obvious truncation indicators
    const truncationIndicators = [
      { pattern: /```\s*$/, msg: "Unclosed code block - likely truncated" },
      { pattern: /<[^>]*$/, msg: "Unclosed HTML tag - likely truncated" },
      { pattern: /[\{\[\(]\s*$/, msg: "Unclosed bracket/brace - likely truncated" },
      { pattern: /"[^"]*$/, msg: "Unclosed string quote - likely truncated" },
    ];

    for (const indicator of truncationIndicators) {
      if (indicator.pattern.test(content)) {
        warnings.push(`⚠️ ${indicator.msg}`);
      }
    }

    // Check for unbalanced brackets
    const openBraces = (content.match(/\{/g) || []).length;
    const closeBraces = (content.match(/\}/g) || []).length;
    if (openBraces > closeBraces) {
      warnings.push(`Unbalanced braces: ${openBraces} open, ${closeBraces} close - likely truncated`);
    }

    const openBrackets = (content.match(/\[/g) || []).length;
    const closeBrackets = (content.match(/\]/g) || []).length;
    if (openBrackets > closeBrackets) {
      warnings.push(`Unbalanced brackets: ${openBrackets} open, ${closeBrackets} close - likely truncated`);
    }

    // Check for unclosed HTML
    const openTags = (content.match(/<[^/>]+>/g) || []).length;
    const closeTags = (content.match(/<\/[^>]+>/g) || []).length;
    if (openTags > closeTags + 5) { // Allow some self-closing tags
      warnings.push(`Unclosed HTML tags: ~${openTags - closeTags} more opens than closes - likely truncated`);
    }

    if (expectedSize && content.length < expectedSize * 0.9) {
      warnings.push(`Size mismatch: received ${content.length} bytes, expected ~${expectedSize} bytes`);
    }

    const { slug, absolute } = projectRoot(String(req.params["project"] ?? ""));
    if (!existsSync(absolute)) {
      res.status(404).json(createApiError("Project not found"));
      return;
    }

    const target = absoluteFromProjectRelative(absolute, rel);
    const dir = dirname(target);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(target, content, "utf8");
    res.json(createApiResponse({
      written: true,
      project: slug,
      path: sanitizeRelativePath(rel),
      size: content.length,
      warnings: warnings.length > 0 ? warnings : undefined
    }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

// Append content to existing file (for large file chunked writing)
codingRouter.post("/projects/:project/append", async (req, res) => {
  try {
    ensureCodingRoot();
    const rel = String(req.body?.path ?? "");
    if (!rel) {
      res.status(400).json(createApiError("path is required"));
      return;
    }
    const content = String(req.body?.content ?? "");

    const { slug, absolute } = projectRoot(String(req.params["project"] ?? ""));
    if (!existsSync(absolute)) {
      res.status(404).json(createApiError("Project not found"));
      return;
    }

    const target = absoluteFromProjectRelative(absolute, rel);
    if (!existsSync(target)) {
      res.status(404).json(createApiError("File not found - use write action to create new file"));
      return;
    }

    // Append content to existing file (MUST await to prevent race condition)
    await appendFile(target, content, "utf8");

    res.json(createApiResponse({
      appended: true,
      project: slug,
      path: sanitizeRelativePath(rel),
      appendedSize: content.length
    }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

codingRouter.post("/projects/:project/move", (req, res) => {
  try {
    ensureCodingRoot();
    const fromPath = String(req.body?.fromPath ?? "");
    const toPath = String(req.body?.toPath ?? "");
    if (!fromPath || !toPath) {
      res.status(400).json(createApiError("fromPath and toPath are required"));
      return;
    }

    const { slug, absolute } = projectRoot(String(req.params["project"] ?? ""));
    if (!existsSync(absolute)) {
      res.status(404).json(createApiError("Project not found"));
      return;
    }

    const fromAbs = absoluteFromProjectRelative(absolute, fromPath);
    const toAbs = absoluteFromProjectRelative(absolute, toPath);
    if (!existsSync(fromAbs)) {
      res.status(404).json(createApiError("Source path not found"));
      return;
    }

    const toDir = dirname(toAbs);
    if (!existsSync(toDir)) mkdirSync(toDir, { recursive: true });

    renameSync(fromAbs, toAbs);
    res.json(createApiResponse({ moved: true, project: slug, fromPath: sanitizeRelativePath(fromPath), toPath: sanitizeRelativePath(toPath) }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

codingRouter.delete("/projects/:project/file", (req, res) => {
  try {
    ensureCodingRoot();
    const rel = String(req.query["path"] ?? "");
    if (!rel) {
      res.status(400).json(createApiError("path query parameter is required"));
      return;
    }

    const { slug, absolute } = projectRoot(String(req.params["project"] ?? ""));
    if (!existsSync(absolute)) {
      res.status(404).json(createApiError("Project not found"));
      return;
    }

    const target = absoluteFromProjectRelative(absolute, rel);
    if (!existsSync(target)) {
      res.status(404).json(createApiError("Path not found"));
      return;
    }

    rmSync(target, { recursive: true, force: true });
    res.json(createApiResponse({ deleted: true, project: slug, path: sanitizeRelativePath(rel) }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * Every conversation belonging to a coding project.
 *
 * A coding project is a FOLDER, not a database row, so nothing on the server links it to its
 * chat - the mapping lives in the browser's localStorage. The link that does survive is the
 * naming convention every one of them is created with ("[Coding] <slug>"), so that is what is
 * matched here, plus whatever id the caller knows about. Both together, because neither alone
 * is sufficient: the caller only knows the conversation THIS browser created, while the name
 * scan also picks up ones made in another browser or left behind by an earlier session.
 */
async function findCodingConversations(
  db: DatabaseService,
  slug: string,
  knownConversationId?: number
): Promise<Array<{ id: number; name: string }>> {
  const expectedName = `[Coding] ${slug}`.toLowerCase();
  const found = new Map<number, { id: number; name: string }>();

  try {
    for (const conversation of await db.listConversations()) {
      if ((conversation.name ?? "").trim().toLowerCase() === expectedName) {
        found.set(conversation.id, { id: conversation.id, name: conversation.name ?? "" });
      }
    }
  } catch {
    // A failed scan must not block deleting the files; the known id below still applies.
  }

  if (knownConversationId !== undefined && !found.has(knownConversationId)) {
    try {
      const conversation = await db.getConversation(knownConversationId);
      // Only accept an id that is not already tied to a DIFFERENT project's folder name, so a
      // stale localStorage entry can never take an unrelated chat down with it.
      if (conversation) {
        const name = (conversation.name ?? "").trim();
        if (!name.startsWith("[Coding] ") || name.toLowerCase() === expectedName) {
          found.set(conversation.id, { id: conversation.id, name });
        }
      }
    } catch {
      // Unknown id - nothing to delete.
    }
  }

  return [...found.values()];
}

function parseConversationId(raw: unknown): number | undefined {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Shows exactly what a delete would remove, so the confirmation names real numbers instead
 *  of asking the user to trust that "everything" is the right amount of everything. */
codingRouter.get("/projects/:project/deletion-preview", async (req, res) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const { slug, absolute } = projectRoot(String(req.params["project"] ?? ""));
    if (!existsSync(absolute)) {
      res.status(404).json(createApiError("Project not found"));
      return;
    }

    const entries = listRecursive(absolute);
    const files = entries.filter((entry) => entry.type === "file");
    const conversations = await findCodingConversations(
      db,
      slug,
      parseConversationId(req.query["conversationId"])
    );

    const conversationDetails = await Promise.all(
      conversations.map(async (conversation) => {
        let messageCount = 0;
        try {
          messageCount = (await db.getMessages(conversation.id)).length;
        } catch {
          // Counting is best-effort; the conversation is still listed.
        }
        return { ...conversation, messageCount };
      })
    );

    res.json(createApiResponse({
      project: slug,
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0),
      conversations: conversationDetails,
    }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * Deletes a coding project completely: its directory (sources, checkpoint history, everything)
 * and the chat that belongs to it.
 *
 * Irreversible on purpose - the checkpoint store lives inside the folder, so removing it removes
 * the undo history too. The caller is expected to confirm first; the deletion-preview endpoint
 * above exists so that confirmation can state what is actually at stake.
 */
codingRouter.delete("/projects/:project", async (req, res) => {
  try {
    ensureCodingRoot();
    const db = req.app.locals["db"] as DatabaseService;
    const { slug, absolute } = projectRoot(String(req.params["project"] ?? ""));

    // projectRoot already rejects traversal, but "" would resolve to the coding root itself and
    // wipe every project at once - a slip that has no valid interpretation.
    if (resolve(absolute) === resolve(CODING_ROOT)) {
      res.status(400).json(createApiError("Refusing to delete the coding root"));
      return;
    }
    if (!existsSync(absolute)) {
      res.status(404).json(createApiError("Project not found"));
      return;
    }

    const conversations = await findCodingConversations(
      db,
      slug,
      parseConversationId(req.query["conversationId"])
    );

    // Chats first: if removing the directory fails, the user still sees the project and can
    // retry, which is a far better state than a deleted folder with its chat still listed.
    const deletedConversationIds: number[] = [];
    for (const conversation of conversations) {
      try {
        await db.deleteConversation(conversation.id);
        deletedConversationIds.push(conversation.id);
      } catch (error) {
        console.warn(`Failed to delete conversation ${conversation.id} for coding project ${slug}:`, error);
      }
    }

    rmSync(absolute, { recursive: true, force: true });

    res.json(createApiResponse({
      deleted: true,
      project: slug,
      deletedConversationIds,
    }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

codingRouter.post("/projects/:project/upload", (req, res) => {
  try {
    ensureCodingRoot();
    const fileName = String(req.body?.fileName ?? "");
    const contentBase64 = String(req.body?.contentBase64 ?? "");
    const folder = req.body?.folder ? String(req.body.folder) : "";
    if (!fileName || !contentBase64) {
      res.status(400).json(createApiError("fileName and contentBase64 are required"));
      return;
    }

    const { slug, absolute } = projectRoot(String(req.params["project"] ?? ""));
    if (!existsSync(absolute)) {
      res.status(404).json(createApiError("Project not found"));
      return;
    }

    const safeFileName = sanitizeRelativePath(fileName).split("/").pop() ?? "upload.bin";
    const safeFolder = folder ? sanitizeRelativePath(folder) : "";
    const relativePath = safeFolder ? `${safeFolder}/${safeFileName}` : safeFileName;
    const target = absoluteFromProjectRelative(absolute, relativePath);

    const dir = dirname(target);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const buffer = Buffer.from(contentBase64, "base64");
    writeFileSync(target, buffer);

    res.json(createApiResponse({ uploaded: true, project: slug, path: sanitizeRelativePath(relativePath), size: buffer.length }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

// ── Checkpoints ─────────────────────────────────────────────────────────────
// A coding run rewrites real files. Without a way to see WHAT it changed and to put it back,
// the only recovery was the filesystem tool's single-level .bak - which the very next write to
// the same file overwrites. These three endpoints back the review/undo UI: list the snapshots
// taken before each attempt, read the diff between one of them and the current state, and roll
// the project back to one (which itself snapshots first, so the undo is undoable).

codingRouter.get("/projects/:project/checkpoints", async (req, res) => {
  try {
    const { slug, absolute } = projectRoot(String(req.params["project"] ?? ""));
    if (!existsSync(absolute)) {
      res.status(404).json(createApiError("Project not found"));
      return;
    }
    const checkpoints = await listCheckpoints(absolute);
    res.json(createApiResponse({ project: slug, checkpoints }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

codingRouter.get("/projects/:project/checkpoints/:sha/diff", async (req, res) => {
  try {
    const { slug, absolute } = projectRoot(String(req.params["project"] ?? ""));
    if (!existsSync(absolute)) {
      res.status(404).json(createApiError("Project not found"));
      return;
    }
    const sha = String(req.params["sha"] ?? "");
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      res.status(400).json(createApiError("Invalid checkpoint id"));
      return;
    }
    const against = typeof req.query["against"] === "string" ? (req.query["against"] as string) : undefined;
    if (against !== undefined && !/^[0-9a-f]{7,40}$/i.test(against)) {
      res.status(400).json(createApiError("Invalid comparison checkpoint id"));
      return;
    }
    const diff = await diffCheckpoint(absolute, sha, against ? { against } : {});
    if (!diff) {
      res.status(404).json(createApiError("No checkpoints exist for this project"));
      return;
    }
    res.json(createApiResponse({ project: slug, ...diff }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

codingRouter.post("/projects/:project/checkpoints/:sha/restore", async (req, res) => {
  try {
    const { slug, absolute } = projectRoot(String(req.params["project"] ?? ""));
    if (!existsSync(absolute)) {
      res.status(404).json(createApiError("Project not found"));
      return;
    }
    const sha = String(req.params["sha"] ?? "");
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      res.status(400).json(createApiError("Invalid checkpoint id"));
      return;
    }
    const result = await restoreCheckpoint(absolute, sha);
    if (!result.restored) {
      res.status(400).json(createApiError(result.error ?? "Restore failed"));
      return;
    }
    res.json(createApiResponse({ project: slug, ...result }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});
