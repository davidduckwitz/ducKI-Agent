/**
 * Optional external components (ffmpeg, ffprobe, yt-dlp) that the agent uses but that are NOT
 * required to ship inside the installer. Every component is located through ONE resolution chain:
 *
 *   1. explicit path   (Settings `COMPONENT_PATH_<ID>` or env `<ID>_PATH`)
 *   2. installed pack  (<duckiHome>/components/<group>/, filled by installComponent())
 *   3. bundled binary  (registered by the code that depends on an npm package shipping one)
 *   4. system install  (anything on PATH, e.g. via winget/scoop/choco)
 *
 * Callers never import a binary-shipping npm package directly: they ask resolveComponent() and
 * degrade gracefully ("video analysis unavailable") when nothing is found.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { duckiHome } from "./runtime-paths.js";
import {
  ASSET_PACKS,
  ASSET_PACK_IDS,
  MODULE_PACKS,
  MODULE_PACK_IDS,
  getAssetPackStatus,
  getModulePackStatus,
  installAssetPack,
  installModulePack,
  isAssetPackId,
  isModulePackId,
  removeAssetPack,
  removeModulePack,
  setModulePacksRoot,
  type AssetPackId,
  type ModulePackId,
  type PackStatus,
} from "./module-packs.js";

export type ComponentId = "ffmpeg" | "ffprobe" | "yt-dlp";
/** Binary components plus the npm-module and asset packs from module-packs.ts. */
export type AnyComponentId = ComponentId | ModulePackId | AssetPackId;
export type ComponentSource = "setting" | "pack" | "bundled" | "system" | "missing";

interface ComponentDef {
  id: ComponentId;
  label: string;
  description: string;
  /** Executable base name without extension. */
  exe: string;
  /** Pack that provides this component; components of one group install together. */
  group: "ffmpeg" | "yt-dlp";
  /** Rough download size shown in the UI. */
  approxSizeMb: number;
}

const DEFS: Record<ComponentId, ComponentDef> = {
  ffmpeg: {
    id: "ffmpeg",
    label: "ffmpeg",
    description: "Audio-/Video-Verarbeitung (Videoanalyse, Frames, Audio-Konvertierung).",
    exe: "ffmpeg",
    group: "ffmpeg",
    approxSizeMb: 100,
  },
  ffprobe: {
    id: "ffprobe",
    label: "ffprobe",
    description: "Liest Video-Metadaten (Dauer). Optional - ohne ffprobe wird die Dauer über ffmpeg ermittelt.",
    exe: "ffprobe",
    group: "ffmpeg",
    approxSizeMb: 100,
  },
  "yt-dlp": {
    id: "yt-dlp",
    label: "yt-dlp",
    description: "Lädt Videos von YouTube, TikTok, Instagram, X und vielen weiteren Seiten.",
    exe: "yt-dlp",
    group: "yt-dlp",
    approxSizeMb: 18,
  },
};

export const COMPONENT_IDS = Object.keys(DEFS) as ComponentId[];

export function isComponentId(value: unknown): value is ComponentId {
  return typeof value === "string" && value in DEFS;
}

export function isAnyComponentId(value: unknown): value is AnyComponentId {
  return isComponentId(value) || isModulePackId(value) || isAssetPackId(value);
}

/** DB settings key for an explicit path, e.g. COMPONENT_PATH_YT_DLP. */
export function componentSettingKey(id: ComponentId): string {
  return `COMPONENT_PATH_${id.toUpperCase().replace(/-/g, "_")}`;
}

function envVarName(id: ComponentId): string {
  return `${id.toUpperCase().replace(/-/g, "_")}_PATH`;
}

export function componentsRoot(): string {
  return join(process.env["DUCKI_COMPONENTS_DIR"]?.trim() || join(duckiHome(), "components"));
}
setModulePacksRoot(componentsRoot);

const exeFile = (name: string): string => (process.platform === "win32" ? `${name}.exe` : name);
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const pathOverrides = new Map<ComponentId, string>();
const bundledPaths = new Map<ComponentId, string>();

/** Server wires the Settings values in here (startup + on change). Empty/undefined clears. */
export function setComponentPathOverride(id: ComponentId, value: string | undefined | null): void {
  const trimmed = value?.trim();
  if (trimmed) pathOverrides.set(id, trimmed);
  else pathOverrides.delete(id);
}

/** For code that depends on an npm package which ships its own binary (dev/monorepo or kept in the installer). */
export function registerBundledComponent(id: ComponentId, binaryPath: string | null | undefined): void {
  if (binaryPath && isFile(binaryPath)) bundledPaths.set(id, binaryPath);
}

function findOnPath(name: string): string | undefined {
  const dirs = (process.env["PATH"] ?? process.env["Path"] ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface ResolvedComponent {
  source: ComponentSource;
  path?: string;
}

export function resolveComponent(id: ComponentId): ResolvedComponent {
  const def = DEFS[id];
  const explicit = pathOverrides.get(id) ?? process.env[envVarName(id)]?.trim();
  if (explicit && isFile(explicit)) return { source: "setting", path: explicit };

  const packFile = join(componentsRoot(), def.group, exeFile(def.exe));
  if (isFile(packFile)) return { source: "pack", path: packFile };

  const bundled = bundledPaths.get(id);
  if (bundled && isFile(bundled)) return { source: "bundled", path: bundled };

  const system = findOnPath(def.exe);
  if (system) return { source: "system", path: system };

  return { source: "missing" };
}

/** Convenience: the usable path or undefined. */
export function resolveComponentPath(id: ComponentId): string | undefined {
  return resolveComponent(id).path;
}

// ---------------------------------------------------------------------------------------------
// Status (for the Settings UI)
// ---------------------------------------------------------------------------------------------

export interface ComponentStatus {
  id: AnyComponentId;
  /** "binary" = executable (path override possible); "module"/"asset" = installable pack only. */
  kind: "binary" | "module" | "asset";
  label: string;
  description: string;
  found: boolean;
  source: ComponentSource;
  path?: string;
  version?: string;
  /** True when the binary exists but does not run (wrong arch, blocked, corrupt). */
  broken?: boolean;
  installable: boolean;
  approxSizeMb: number;
  explicitPath?: string;
  installing?: boolean;
  /** Download progress 0-100 while installing (-1 = unknown), plus the phase. */
  installPhase?: InstallProgress["phase"];
  installPercent?: number;
  /** Message of the last failed install attempt of this pack. */
  installError?: string;
}

function probeVersion(path: string, id: ComponentId): Promise<string | undefined> {
  const args = id === "yt-dlp" ? ["--version"] : ["-version"];
  return new Promise((resolve) => {
    execFile(path, args, { timeout: 8000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(undefined);
      const first = String(stdout).split(/\r?\n/)[0]?.trim() ?? "";
      resolve(first.replace(/^(ffmpeg|ffprobe) version\s+/i, "").split(" ")[0] || first || "ok");
    });
  });
}

function packStatus(
  id: ModulePackId | AssetPackId,
  kind: "module" | "asset",
  def: { label: string; description: string; approxSizeMb: number },
  status: PackStatus,
): ComponentStatus {
  return {
    id,
    kind,
    label: def.label,
    description: def.description,
    found: status.installed || status.shipped,
    source: status.installed ? "pack" : status.shipped ? "bundled" : "missing",
    path: status.path,
    version: status.version,
    installable: status.installable,
    approxSizeMb: def.approxSizeMb,
    installing: activeInstalls.has(id),
    installPhase: installState.get(id)?.phase,
    installPercent: installState.get(id)?.percent,
    installError: installErrors.get(id),
  };
}

export async function getComponentStatuses(): Promise<ComponentStatus[]> {
  const binaries = await Promise.all(
    COMPONENT_IDS.map(async (id): Promise<ComponentStatus> => {
      const def = DEFS[id];
      const resolved = resolveComponent(id);
      const version = resolved.path ? await probeVersion(resolved.path, id) : undefined;
      return {
        id,
        kind: "binary",
        label: def.label,
        description: def.description,
        found: Boolean(resolved.path) && version !== undefined,
        source: resolved.source,
        path: resolved.path,
        version,
        broken: Boolean(resolved.path) && version === undefined,
        installable: process.platform === "win32" && process.arch === "x64",
        approxSizeMb: def.approxSizeMb,
        explicitPath: pathOverrides.get(id),
        installing: activeInstalls.has(def.group),
        installPhase: installState.get(def.group)?.phase,
        installPercent: installState.get(def.group)?.percent,
        installError: installErrors.get(def.group),
      };
    }),
  );
  return [
    ...binaries,
    ...MODULE_PACK_IDS.map((id) => packStatus(id, "module", MODULE_PACKS[id], getModulePackStatus(id))),
    ...ASSET_PACK_IDS.map((id) => packStatus(id, "asset", ASSET_PACKS[id], getAssetPackStatus(id))),
  ];
}

// ---------------------------------------------------------------------------------------------
// Installation (Windows x64 only; other platforms use a system install)
// ---------------------------------------------------------------------------------------------

export interface InstallProgress {
  phase: "download" | "verify" | "extract" | "done";
  received: number;
  total: number;
}

const activeInstalls = new Set<string>();
const installState = new Map<string, { phase: InstallProgress["phase"]; percent: number }>();
const installErrors = new Map<string, string>();

interface PackSource {
  url: string;
  /** Fetches the expected SHA-256 (hex) for the download. */
  expectedSha256: () => Promise<string>;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} bei ${url}`);
  return res.text();
}

const SOURCES: Record<"ffmpeg" | "yt-dlp", PackSource> = {
  // gyan.dev publishes the SHA-256 of each build next to the archive.
  ffmpeg: {
    url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    expectedSha256: async () => {
      const text = await fetchText("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256");
      const m = text.match(/[a-f0-9]{64}/i);
      if (!m) throw new Error("Prüfsumme für ffmpeg konnte nicht gelesen werden");
      return m[0].toLowerCase();
    },
  },
  "yt-dlp": {
    url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
    expectedSha256: async () => {
      const text = await fetchText("https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS");
      const line = text.split(/\r?\n/).find((l) => /\s\*?yt-dlp\.exe\s*$/.test(l));
      const m = line?.match(/^([a-f0-9]{64})/i);
      if (!m) throw new Error("Prüfsumme für yt-dlp konnte nicht gelesen werden");
      return m[1]!.toLowerCase();
    },
  },
};

async function download(url: string, dest: string, onProgress?: (p: InstallProgress) => void): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let received = 0;
  const source = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.({ phase: "download", received, total });
  });
  await pipeline(source, createWriteStream(dest));
}

function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (d) => hash.update(d));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function extractZip(zip: string, destDir: string): Promise<void> {
  // Windows' own bsdtar (Windows 10+) reads zip archives. Use the absolute path: a GNU tar earlier
  // on PATH (Git for Windows) mistakes "C:\..." for a remote host.
  const tar = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe");
  return new Promise((resolve, reject) => {
    execFile(tar, ["-xf", zip, "-C", destDir], { windowsHide: true, timeout: 5 * 60_000 }, (error, _out, stderr) => {
      if (error) reject(new Error(`Entpacken fehlgeschlagen: ${String(stderr || error.message).trim()}`));
      else resolve();
    });
  });
}

function findFile(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === name) {
      return full;
    }
  }
  return undefined;
}

/** npm-module / asset packs: same progress/error bookkeeping as the binary packs, keyed by id. */
async function installPack(id: ModulePackId | AssetPackId, onProgress?: (p: InstallProgress) => void): Promise<void> {
  if (activeInstalls.has(id)) throw new Error(`${id} wird bereits installiert`);
  activeInstalls.add(id);
  installErrors.delete(id);
  const report = (p: InstallProgress): void => {
    installState.set(id, { phase: p.phase, percent: p.total > 0 ? Math.floor((p.received / p.total) * 100) : -1 });
    onProgress?.(p);
  };
  try {
    if (isModulePackId(id)) await installModulePack(id, report);
    else await installAssetPack(id, report);
  } catch (error) {
    installErrors.set(id, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    activeInstalls.delete(id);
    installState.delete(id);
  }
}

/** Installs the pack that provides `id` (ffmpeg and ffprobe share one pack). */
export async function installComponent(id: AnyComponentId, onProgress?: (p: InstallProgress) => void): Promise<void> {
  if (!isComponentId(id)) return installPack(id, onProgress);
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Automatische Installation gibt es nur für Windows x64. Bitte installiere die Komponente systemweit oder setze einen Pfad.");
  }
  const group = DEFS[id].group;
  if (activeInstalls.has(group)) throw new Error(`${group} wird bereits installiert`);
  activeInstalls.add(group);
  installErrors.delete(group);
  const report = (p: InstallProgress): void => {
    installState.set(group, { phase: p.phase, percent: p.total > 0 ? Math.floor((p.received / p.total) * 100) : -1 });
    onProgress?.(p);
  };

  const groupDir = join(componentsRoot(), group);
  const workDir = join(componentsRoot(), `.tmp-${group}-${Date.now()}`);
  try {
    mkdirSync(workDir, { recursive: true });
    const source = SOURCES[group];
    const expected = await source.expectedSha256();
    const archive = join(workDir, group === "ffmpeg" ? "pack.zip" : "yt-dlp.exe");
    await download(source.url, archive, report);

    report({ phase: "verify", received: 0, total: 0 });
    const actual = await sha256Of(archive);
    if (actual !== expected) throw new Error("Prüfsumme stimmt nicht überein - Download wurde verworfen.");

    mkdirSync(groupDir, { recursive: true });
    if (group === "ffmpeg") {
      report({ phase: "extract", received: 0, total: 0 });
      const extracted = join(workDir, "x");
      mkdirSync(extracted);
      await extractZip(archive, extracted);
      for (const name of ["ffmpeg.exe", "ffprobe.exe"]) {
        const found = findFile(extracted, name);
        if (!found) throw new Error(`${name} nicht im Archiv gefunden`);
        copyFileSync(found, join(groupDir, name));
      }
    } else {
      copyFileSync(archive, join(groupDir, "yt-dlp.exe"));
    }
    report({ phase: "done", received: 1, total: 1 });
  } catch (error) {
    installErrors.set(group, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    activeInstalls.delete(group);
    installState.delete(group);
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function removeComponentPack(id: AnyComponentId): void {
  if (isModulePackId(id)) return removeModulePack(id);
  if (isAssetPackId(id)) return removeAssetPack(id);
  rmSync(join(componentsRoot(), DEFS[id].group), { recursive: true, force: true });
}
