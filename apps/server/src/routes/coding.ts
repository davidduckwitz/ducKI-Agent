import { Router, type IRouter } from "express";
import { createApiError, createApiResponse } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

export const codingRouter: IRouter = Router();

const SHARED_ROOT = resolve(process.env["SHARED_WORKSPACE_PATH"] ?? "./shared-workspace");
export const CODING_ROOT = resolve(SHARED_ROOT, "coding");

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

function listRecursive(root: string, relativePrefix = ""): Array<{ path: string; type: "file" | "directory"; size?: number; updatedAt?: string }> {
  const entries = readdirSync(root, { withFileTypes: true });
  const out: Array<{ path: string; type: "file" | "directory"; size?: number; updatedAt?: string }> = [];

  for (const entry of entries) {
    const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const absPath = join(root, entry.name);
    if (entry.isDirectory()) {
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

    const { slug, absolute } = projectRoot(String(req.params["project"] ?? ""));
    if (!existsSync(absolute)) {
      res.status(404).json(createApiError("Project not found"));
      return;
    }

    const target = absoluteFromProjectRelative(absolute, rel);
    const dir = dirname(target);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(target, content, "utf8");
    res.json(createApiResponse({ written: true, project: slug, path: sanitizeRelativePath(rel) }));
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
