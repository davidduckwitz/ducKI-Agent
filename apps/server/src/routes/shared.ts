import { Router, type IRouter } from "express";
import { createApiError, createApiResponse } from "@ducki/shared";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

export const sharedRouter: IRouter = Router();

const SHARED_ROOT = resolve(process.env["SHARED_WORKSPACE_PATH"] ?? "./shared-workspace");

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".ts", ".tsx", ".js", ".jsx", ".py", ".yml", ".yaml", ".xml", ".csv", ".html", ".css",
]);

function ensureSharedRoot(): void {
  if (!existsSync(SHARED_ROOT)) {
    mkdirSync(SHARED_ROOT, { recursive: true });
  }
}

function sanitizeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  if (!normalized) return "";
  if (normalized.includes("..")) {
    throw new Error("Path traversal is not allowed");
  }
  return normalized;
}

function absoluteFromRelative(relativePath: string): string {
  const clean = sanitizeRelativePath(relativePath);
  const abs = resolve(SHARED_ROOT, clean);
  if (!abs.startsWith(SHARED_ROOT)) {
    throw new Error("Path escapes shared workspace");
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

sharedRouter.get("/files", (_req, res) => {
  ensureSharedRoot();
  const files = listRecursive(SHARED_ROOT);
  res.json(createApiResponse({ root: SHARED_ROOT, files }));
});

sharedRouter.get("/read", (req, res) => {
  try {
    ensureSharedRoot();
    const relativePath = String(req.query["path"] ?? "");
    if (!relativePath) {
      res.status(400).json(createApiError("path query parameter is required"));
      return;
    }

    const absolutePath = absoluteFromRelative(relativePath);
    if (!existsSync(absolutePath)) {
      res.status(404).json(createApiError("File not found"));
      return;
    }

    const ext = extname(absolutePath).toLowerCase();
    const buffer = readFileSync(absolutePath);
    const isText = TEXT_EXTENSIONS.has(ext);

    res.json(
      createApiResponse({
        path: sanitizeRelativePath(relativePath),
        size: buffer.length,
        isText,
        content: isText ? buffer.toString("utf8") : undefined,
        contentBase64: !isText ? buffer.toString("base64") : undefined,
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

sharedRouter.get("/download", (req, res) => {
  try {
    ensureSharedRoot();
    const relativePath = String(req.query["path"] ?? "");
    if (!relativePath) {
      res.status(400).json(createApiError("path query parameter is required"));
      return;
    }

    const cleanPath = sanitizeRelativePath(relativePath);
    const absolutePath = absoluteFromRelative(cleanPath);
    if (!existsSync(absolutePath)) {
      res.status(404).json(createApiError("File not found"));
      return;
    }

    const fileName = cleanPath.split("/").pop() ?? "download.bin";
    res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);
    res.sendFile(absolutePath);
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

sharedRouter.post("/write", (req, res) => {
  try {
    ensureSharedRoot();
    const { path, content } = req.body as { path?: string; content?: string };
    if (!path) {
      res.status(400).json(createApiError("path is required"));
      return;
    }

    const absolutePath = absoluteFromRelative(path);
    const dir = dirname(absolutePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(absolutePath, String(content ?? ""), "utf8");
    res.json(createApiResponse({ written: true, path: sanitizeRelativePath(path) }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

sharedRouter.post("/upload", (req, res) => {
  try {
    ensureSharedRoot();
    const { fileName, contentBase64, folder } = req.body as { fileName?: string; contentBase64?: string; folder?: string };
    if (!fileName || !contentBase64) {
      res.status(400).json(createApiError("fileName and contentBase64 are required"));
      return;
    }

    const safeFileName = sanitizeRelativePath(fileName).split("/").pop() ?? "upload.bin";
    const safeFolder = folder ? sanitizeRelativePath(folder) : "";
    const relativePath = safeFolder ? `${safeFolder}/${safeFileName}` : safeFileName;
    const absolutePath = absoluteFromRelative(relativePath);

    const dir = dirname(absolutePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const buffer = Buffer.from(contentBase64, "base64");
    writeFileSync(absolutePath, buffer);

    res.json(createApiResponse({ uploaded: true, path: relativePath, size: buffer.length }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

sharedRouter.post("/move", (req, res) => {
  try {
    ensureSharedRoot();
    const { fromPath, toPath } = req.body as { fromPath?: string; toPath?: string };
    if (!fromPath || !toPath) {
      res.status(400).json(createApiError("fromPath and toPath are required"));
      return;
    }

    const fromAbs = absoluteFromRelative(fromPath);
    const toAbs = absoluteFromRelative(toPath);

    if (!existsSync(fromAbs)) {
      res.status(404).json(createApiError("Source path not found"));
      return;
    }

    const toDir = dirname(toAbs);
    if (!existsSync(toDir)) mkdirSync(toDir, { recursive: true });

    renameSync(fromAbs, toAbs);

    res.json(createApiResponse({ moved: true, fromPath: sanitizeRelativePath(fromPath), toPath: sanitizeRelativePath(toPath) }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

sharedRouter.delete("/file", (req, res) => {
  try {
    ensureSharedRoot();
    const relativePath = String(req.query["path"] ?? "");
    if (!relativePath) {
      res.status(400).json(createApiError("path query parameter is required"));
      return;
    }

    const absolutePath = absoluteFromRelative(relativePath);
    if (!existsSync(absolutePath)) {
      res.status(404).json(createApiError("Path not found"));
      return;
    }

    rmSync(absolutePath, { recursive: true, force: true });
    res.json(createApiResponse({ deleted: true, path: sanitizeRelativePath(relativePath) }));
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});
