/**
 * Optional npm-module and asset packs - the JS counterpart to the binary components in
 * components.ts. Features that pull in heavy npm packages (browser automation, crypto wallets,
 * nodejs-whisper) or large frontend assets (Monaco's TypeScript worker) are left out of the desktop
 * installer and installed on demand from Settings > Komponenten.
 *
 * Reproducibility: the desktop build (apps/tauri-desktop/build.js) resolves every pack against the
 * monorepo's exact versions and writes `module-packs.json` next to the server bundle - every
 * tarball URL plus its npm integrity hash. Installing a pack downloads exactly those tarballs,
 * verifies each one and extracts them into <components>/npm/<pack>/node_modules/... - no npm, no
 * re-resolution against the live registry at runtime.
 *
 * Loading: callers pass their own literal `() => import("pkg")` so the normal resolution keeps
 * working in the monorepo and whenever the package still ships with the app; only when that fails
 * with "module not found" does loadOptionalModule() fall back to the installed pack.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ModulePackId = "browser" | "crypto-wallets" | "nodejs-whisper";
export type AssetPackId = "monaco-ts";

interface ModulePackDef {
  label: string;
  description: string;
  /** Top-level packages the pack provides (pinned by the build). */
  modules: string[];
  approxSizeMb: number;
}

interface AssetPackDef {
  label: string;
  description: string;
  approxSizeMb: number;
}

/** Exported so the desktop build script can read the module list from one place. */
export const MODULE_PACKS: Record<ModulePackId, ModulePackDef> = {
  browser: {
    label: "Browser-Automatisierung",
    description: "Puppeteer für das Browser-Tool (Seiten öffnen, klicken, Screenshots). Benötigt zusätzlich ein installiertes Chrome/Edge.",
    modules: ["puppeteer-core"],
    approxSizeMb: 6,
  },
  "crypto-wallets": {
    label: "Krypto-Wallets",
    description: "Bitcoin-/Ethereum-/XRP-Wallets und den Bitcoin-Puzzle-Solver.",
    modules: ["tiny-secp256k1", "ecpair", "bitcoinjs-lib", "bip32", "bip39", "ethers", "xrpl"],
    approxSizeMb: 8,
  },
  "nodejs-whisper": {
    label: "nodejs-whisper",
    description: "Lokaler Whisper-Fallback für Spracherkennung. Wird beim ersten Einsatz kompiliert (benötigt CMake + C++-Compiler). Normalerweise reicht faster-whisper.",
    modules: ["nodejs-whisper"],
    approxSizeMb: 4,
  },
};

export const ASSET_PACKS: Record<AssetPackId, AssetPackDef> = {
  "monaco-ts": {
    label: "TypeScript im Code-Editor",
    description: "Autovervollständigung, Fehleranzeige und Typ-Infos für TypeScript/JavaScript im Code-Editor. Ohne gibt es nur Syntax-Hervorhebung.",
    approxSizeMb: 7,
  },
};

export const MODULE_PACK_IDS = Object.keys(MODULE_PACKS) as ModulePackId[];
export const ASSET_PACK_IDS = Object.keys(ASSET_PACKS) as AssetPackId[];

export function isModulePackId(value: unknown): value is ModulePackId {
  return typeof value === "string" && value in MODULE_PACKS;
}

export function isAssetPackId(value: unknown): value is AssetPackId {
  return typeof value === "string" && value in ASSET_PACKS;
}

// ---------------------------------------------------------------------------------------------
// Manifest (written by the desktop build)
// ---------------------------------------------------------------------------------------------

export interface ModulePackEntry {
  /** Install location relative to the pack root, e.g. "node_modules/a/node_modules/b". */
  path: string;
  version: string;
  resolved: string;
  integrity: string;
}

export interface AssetPackEntry {
  url: string;
  sha256: string;
  file: string;
}

export interface ModulePacksManifest {
  npm: Partial<Record<ModulePackId, { entries: ModulePackEntry[] }>>;
  assets: Partial<Record<AssetPackId, AssetPackEntry>>;
}

let manifestCache: ModulePacksManifest | null | undefined;

function readManifest(): ModulePacksManifest | null {
  if (manifestCache !== undefined) return manifestCache;
  const candidates = [
    process.env["DUCKI_MODULE_PACKS_MANIFEST"]?.trim(),
    // In the packaged app this module is inlined into server-dist/index.js, next to the manifest.
    fileURLToPath(new URL("./module-packs.json", import.meta.url)),
  ].filter((p): p is string => Boolean(p));
  manifestCache = null;
  for (const file of candidates) {
    try {
      manifestCache = JSON.parse(readFileSync(file, "utf8")) as ModulePacksManifest;
      break;
    } catch {
      /* not packaged / not present */
    }
  }
  return manifestCache;
}

// ---------------------------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------------------------

let rootResolver: () => string = () => {
  throw new Error("module-packs: components root not configured");
};

/** components.ts hands in its root resolver (avoids an import cycle). */
export function setModulePacksRoot(resolver: () => string): void {
  rootResolver = resolver;
}

function modulePackDir(id: ModulePackId): string {
  return join(rootResolver(), "npm", id);
}

function assetPackFile(id: AssetPackId): string {
  return join(rootResolver(), "assets", id, readManifest()?.assets[id]?.file ?? `${id}.js`);
}

const LOADER_FILE = "loader.mjs";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isModulePackInstalled(id: ModulePackId): boolean {
  return isFile(join(modulePackDir(id), LOADER_FILE));
}

export function isAssetPackInstalled(id: AssetPackId): boolean {
  return isFile(assetPackFile(id));
}

/** Path of an installed asset (e.g. for an HTTP route to serve it), or undefined. */
export function assetPackPath(id: AssetPackId): string | undefined {
  const file = assetPackFile(id);
  return isFile(file) ? file : undefined;
}

function packForModule(spec: string): ModulePackId | undefined {
  return MODULE_PACK_IDS.find((id) => MODULE_PACKS[id].modules.includes(spec));
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

export class OptionalModuleMissingError extends Error {
  readonly code = "DUCKI_OPTIONAL_MODULE_MISSING";
  constructor(
    readonly spec: string,
    readonly pack: ModulePackId | undefined,
  ) {
    super(
      pack
        ? `"${spec}" ist nicht installiert. Installiere die Komponente "${MODULE_PACKS[pack].label}" unter Einstellungen > Komponenten.`
        : `"${spec}" ist nicht installiert.`,
    );
    this.name = "OptionalModuleMissingError";
  }
}

function isNotFound(error: unknown, spec: string): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`'${spec}'`) || message.includes(`"${spec}"`);
}

/** Modules seen working through the caller's own import (monorepo / still shipped). */
const resolvedViaPrimary = new Set<string>();

/**
 * Imports `spec` through the caller's own `primary` import, falling back to the installed pack.
 * Throws OptionalModuleMissingError when neither has it.
 */
export async function loadOptionalModule<T>(spec: string, primary: () => Promise<T>): Promise<T> {
  try {
    const mod = await primary();
    resolvedViaPrimary.add(spec);
    return mod;
  } catch (error) {
    if (!isNotFound(error, spec)) throw error;
  }
  const pack = packForModule(spec);
  if (pack && isModulePackInstalled(pack)) {
    // loader.mjs does `import(spec)` from inside the pack dir, so Node's normal ESM resolution
    // (exports maps, conditions, nested node_modules) walks the pack's own node_modules.
    const loader = (await import(pathToFileURL(join(modulePackDir(pack), LOADER_FILE)).href)) as {
      default: (s: string) => Promise<T>;
    };
    return loader.default(spec);
  }
  throw new OptionalModuleMissingError(spec, pack);
}

/** Sync counterpart for code that needs a file path (e.g. spawns a package's CLI). */
export function resolveOptionalModule(spec: string, primary: () => string): string {
  try {
    const path = primary();
    resolvedViaPrimary.add(spec);
    return path;
  } catch (error) {
    if (!isNotFound(error, spec)) throw error;
  }
  const pack = packForModule(spec);
  if (pack && isModulePackInstalled(pack)) {
    return createRequire(join(modulePackDir(pack), "package.json")).resolve(spec);
  }
  throw new OptionalModuleMissingError(spec, pack);
}

/** True when the pack's modules ship with the app (bundle node_modules) or were already loaded. */
function modulesShipped(id: ModulePackId): boolean {
  const req = createRequire(import.meta.url);
  return MODULE_PACKS[id].modules.every((spec) => {
    if (resolvedViaPrimary.has(spec)) return true;
    try {
      req.resolve(spec);
      return true;
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

export interface PackStatus {
  installed: boolean;
  shipped: boolean;
  installable: boolean;
  path?: string;
  version?: string;
}

export function getModulePackStatus(id: ModulePackId): PackStatus {
  const installed = isModulePackInstalled(id);
  const entries = readManifest()?.npm[id]?.entries;
  const main = MODULE_PACKS[id].modules[0];
  const version = entries?.find((e) => e.path === `node_modules/${main}`)?.version;
  return {
    installed,
    shipped: !installed && modulesShipped(id),
    installable: Boolean(entries?.length),
    path: installed ? modulePackDir(id) : undefined,
    version,
  };
}

export function getAssetPackStatus(id: AssetPackId): PackStatus {
  const path = assetPackPath(id);
  return { installed: Boolean(path), shipped: false, installable: Boolean(readManifest()?.assets[id]), path };
}

// ---------------------------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------------------------

export interface PackInstallProgress {
  phase: "download" | "verify" | "extract" | "done";
  received: number;
  total: number;
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download fehlgeschlagen (HTTP ${res.status}) bei ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** npm's subresource-integrity string, e.g. "sha512-<base64>" (several may be space-separated). */
function matchesIntegrity(data: Buffer, integrity: string): boolean {
  return integrity.split(/\s+/).some((item) => {
    const dash = item.indexOf("-");
    const algo = item.slice(0, dash);
    if (!["sha512", "sha384", "sha256", "sha1"].includes(algo)) return false;
    return createHash(algo).update(data).digest("base64") === item.slice(dash + 1);
  });
}

function tarBinary(): string {
  // Windows' own bsdtar; a GNU tar earlier on PATH (Git for Windows) mistakes "C:\..." for a host.
  return process.platform === "win32" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

function extractTarball(file: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  return new Promise((resolve, reject) => {
    // npm tarballs wrap everything in one top-level dir (usually "package/").
    execFile(tarBinary(), ["-xzf", file, "-C", destDir, "--strip-components=1"], { windowsHide: true, timeout: 5 * 60_000 }, (error, _out, stderr) => {
      if (error) reject(new Error(`Entpacken fehlgeschlagen: ${String(stderr || error.message).trim()}`));
      else resolve();
    });
  });
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

export async function installModulePack(id: ModulePackId, onProgress?: (p: PackInstallProgress) => void): Promise<void> {
  const entries = readManifest()?.npm[id]?.entries;
  if (!entries?.length) throw new Error(`Für "${MODULE_PACKS[id].label}" gibt es in dieser Version kein Installationspaket.`);

  const finalDir = modulePackDir(id);
  const workDir = `${finalDir}.tmp-${Date.now()}`;
  const downloads = join(workDir, ".downloads");
  try {
    mkdirSync(downloads, { recursive: true });
    let done = 0;
    await mapLimit(entries, 6, async (entry) => {
      const data = await fetchBuffer(entry.resolved);
      if (!matchesIntegrity(data, entry.integrity)) {
        throw new Error(`Prüfsumme von ${entry.path.replace(/^.*node_modules\//, "")}@${entry.version} stimmt nicht - Installation abgebrochen.`);
      }
      const file = join(downloads, `${createHash("sha1").update(entry.path).digest("hex")}.tgz`);
      writeFileSync(file, data);
      await extractTarball(file, join(workDir, entry.path));
      done += 1;
      onProgress?.({ phase: "download", received: done, total: entries.length });
    });
    rmSync(downloads, { recursive: true, force: true });
    writeFileSync(join(workDir, "package.json"), JSON.stringify({ name: `ducki-pack-${id}`, private: true, type: "module" }, null, 2));
    writeFileSync(join(workDir, LOADER_FILE), "export default (spec) => import(spec);\n");
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(workDir, finalDir);
    onProgress?.({ phase: "done", received: 1, total: 1 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
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

export async function installAssetPack(id: AssetPackId, onProgress?: (p: PackInstallProgress) => void): Promise<void> {
  const asset = readManifest()?.assets[id];
  if (!asset) throw new Error(`Für "${ASSET_PACKS[id].label}" gibt es in dieser Version kein Installationspaket.`);
  onProgress?.({ phase: "download", received: 0, total: 0 });
  const data = await fetchBuffer(asset.url);
  const target = assetPackFile(id);
  const tmp = `${target}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(tmp, data);
  onProgress?.({ phase: "verify", received: 0, total: 0 });
  if ((await sha256Of(tmp)) !== asset.sha256) {
    rmSync(tmp, { force: true });
    throw new Error("Prüfsumme stimmt nicht überein - Download wurde verworfen.");
  }
  rmSync(target, { force: true });
  renameSync(tmp, target);
  onProgress?.({ phase: "done", received: 1, total: 1 });
}

export function removeModulePack(id: ModulePackId): void {
  rmSync(modulePackDir(id), { recursive: true, force: true });
}

export function removeAssetPack(id: AssetPackId): void {
  const file = assetPackFile(id);
  if (existsSync(dirname(file))) rmSync(dirname(file), { recursive: true, force: true });
}
