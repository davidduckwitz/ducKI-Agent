/**
 * Cloud-Backup/-Restore fuer selbstgehostete (BYO) Agenten gegen die ducki.cloud Laravel-API
 * (siehe `AgentBackupController` im ducki-cloud-v1 Repo). Snapshot-basiert, kein Live-Sync:
 * `createBackup()` packt Haupt-DB, alle Plugin-DBs, das Shared-Workspace und den Skills-Ordner
 * in ein tar.gz und laedt es hoch; `restoreLatestBackup()` laedt das neueste Backup herunter und
 * spielt es an Ort und Stelle zurueck.
 *
 * Auth: wiederverwendet die bestehenden Wave-API-Keys aus /settings/api (POST /api/token
 * tauscht den Key gegen ein 1h-JWT). Der API-Key wird AES-256-GCM-verschluesselt (wie
 * Plugin-Secrets) unter der Setting "CLOUD_API_KEY" in der Haupt-DB abgelegt.
 *
 * Restore ueberschreibt Dateien, die evtl. gerade von der laufenden Server-Instanz offen
 * gehalten werden (Haupt-DB, Plugin-DBs). Dafuer schliesst restoreLatestBackup() vor dem
 * Zurueckspielen alle DB-Verbindungen (closeAllPluginDbs + resetDatabaseInstance); der Aufrufer
 * (Route-Handler) muss den Prozess danach neu starten (Windows haelt offene SQLite-Dateien
 * gesperrt, ein Hot-Swap ist nicht sicher moeglich).
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import * as tar from "tar";
import {
  type DatabaseService,
  encryptSecret,
  decryptSecret,
  isEncrypted,
  closeAllPluginDbs,
  resetDatabaseInstance,
  vacuumSqliteFile,
} from "@ducki/database";
import { pluginsRoot, loadPlugins } from "@ducki/agent";
import { SHARED_WORKSPACE_ROOT } from "@ducki/tools";

const SETTING_API_KEY = "CLOUD_API_KEY";
const SETTING_BASE_URL = "CLOUD_BASE_URL";
const DEFAULT_BASE_URL = "https://ducki.cloud";
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAIN_DB_DEFAULT_PATH = "./storage/ducki.db";

export class CloudSyncError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "CloudSyncError";
  }
}

export interface BackupSummary {
  id: number;
  filename: string;
  device_name: string | null;
  size_bytes: number;
  checksum: string | null;
  manifest: Record<string, unknown> | null;
  created_at: string;
}

export interface CreateBackupResult {
  backup: BackupSummary;
}

function resolveSkillsRoot(): string {
  const configured = process.env["SKILLS_PATH"]?.trim();
  if (configured) return resolve(configured);
  const monorepoCandidate = resolve(process.cwd(), "../../skills");
  if (existsSync(monorepoCandidate)) return monorepoCandidate;
  return resolve(process.cwd(), "skills");
}

async function readAgentVersion(): Promise<string> {
  try {
    const raw = await readFile(resolve(process.cwd(), "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ============================================================
// Connection (API key -> JWT)
// ============================================================

export async function getCloudBaseUrl(db: DatabaseService): Promise<string> {
  const stored = await db.getSetting(SETTING_BASE_URL);
  return stored?.trim() || process.env["DUCKI_CLOUD_URL"]?.trim() || DEFAULT_BASE_URL;
}

export async function getConnectionStatus(db: DatabaseService): Promise<{ connected: boolean; baseUrl: string }> {
  const [key, baseUrl] = await Promise.all([db.getSetting(SETTING_API_KEY), getCloudBaseUrl(db)]);
  return { connected: !!key, baseUrl };
}

async function getDecryptedApiKey(db: DatabaseService): Promise<string> {
  const stored = await db.getSetting(SETTING_API_KEY);
  if (!stored) throw new CloudSyncError("Kein Cloud-API-Key hinterlegt. Bitte zuerst verbinden.", 401);
  return isEncrypted(stored) ? decryptSecret(stored) : stored;
}

async function exchangeForJwt(baseUrl: string, apiKey: string): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: apiKey }),
  });
  if (!res.ok) {
    throw new CloudSyncError(`Cloud-Login fehlgeschlagen (HTTP ${res.status}). API-Key gueltig?`, res.status);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new CloudSyncError("Cloud-Login lieferte kein Token.");
  return data.access_token;
}

/** Validiert den API-Key gegen die Cloud (Login-Versuch) und speichert ihn erst danach verschluesselt. */
export async function connect(db: DatabaseService, rawApiKey: string, baseUrl?: string): Promise<void> {
  const key = rawApiKey.trim();
  if (!key) throw new CloudSyncError("API-Key darf nicht leer sein.");
  const url = baseUrl?.trim() || (await getCloudBaseUrl(db));

  await exchangeForJwt(url, key); // wirft bei ungueltigem Key

  await db.setSetting(SETTING_API_KEY, encryptSecret(key));
  if (baseUrl?.trim()) await db.setSetting(SETTING_BASE_URL, baseUrl.trim());
}

export async function disconnect(db: DatabaseService): Promise<void> {
  await db.deleteSetting(SETTING_API_KEY);
}

async function authedJson<T>(db: DatabaseService, method: string, path: string, jwt: string, body?: unknown): Promise<T> {
  const baseUrl = await getCloudBaseUrl(db);
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CloudSyncError(`Cloud-Anfrage fehlgeschlagen (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status);
  }
  return (await res.json()) as T;
}

export async function listBackups(db: DatabaseService): Promise<BackupSummary[]> {
  const apiKey = await getDecryptedApiKey(db);
  const baseUrl = await getCloudBaseUrl(db);
  const jwt = await exchangeForJwt(baseUrl, apiKey);
  const data = await authedJson<{ data: BackupSummary[] }>(db, "GET", "/api/agent/backup", jwt);
  return data.data;
}

// ============================================================
// Backup creation
// ============================================================

async function snapshotPluginDbs(destDir: string): Promise<{ name: string; version: string; hasStorage: boolean }[]> {
  const root = pluginsRoot();
  const { plugins } = await loadPlugins(root);
  const entries: { name: string; version: string; hasStorage: boolean }[] = [];
  for (const plugin of plugins) {
    entries.push({ name: plugin.name, version: plugin.version, hasStorage: plugin.hasStorage });
    const srcDb = join(root, plugin.name, "data", `${plugin.name}.sqlite`);
    if (!existsSync(srcDb)) continue;
    const destPluginDir = join(destDir, plugin.name, "data");
    await mkdir(destPluginDir, { recursive: true });
    await vacuumSqliteFile(srcDb, join(destPluginDir, `${plugin.name}.sqlite`));
  }
  return entries;
}

export async function createBackup(
  db: DatabaseService,
  opts: { deviceName?: string } = {}
): Promise<CreateBackupResult> {
  const apiKey = await getDecryptedApiKey(db);
  const baseUrl = await getCloudBaseUrl(db);
  const jwt = await exchangeForJwt(baseUrl, apiKey);

  const work = await mkdtemp(join(tmpdir(), "ducki-backup-"));
  const stageDir = join(work, "stage");
  const tarFile = join(work, "backup.tar.gz");
  try {
    await mkdir(join(stageDir, "db"), { recursive: true });
    await mkdir(join(stageDir, "plugins"), { recursive: true });

    // Haupt-DB: konsistenter Snapshot via VACUUM INTO.
    const mainDbPath = resolve(process.env["DATABASE_PATH"] ?? MAIN_DB_DEFAULT_PATH);
    await db.vacuumInto(join(stageDir, "db", "ducki.db"));

    // Plugin-DBs.
    const pluginEntries = await snapshotPluginDbs(join(stageDir, "plugins"));

    // Shared-Workspace (enthaelt bereits coding/ als Unterordner).
    if (existsSync(SHARED_WORKSPACE_ROOT)) {
      await cp(SHARED_WORKSPACE_ROOT, join(stageDir, "shared-workspace"), { recursive: true });
    }

    // Skills.
    const skillsRoot = resolveSkillsRoot();
    if (existsSync(skillsRoot)) {
      await cp(skillsRoot, join(stageDir, "skills"), { recursive: true });
    }

    // Plugin-Secret-Key (sonst sind Plugin-Secrets nach Restore nicht mehr entschluesselbar).
    const secretKeyPath = join(pluginsRoot(), ".secret-key");
    if (existsSync(secretKeyPath)) {
      await cp(secretKeyPath, join(stageDir, ".secret-key"));
    }

    const manifest = {
      agentVersion: await readAgentVersion(),
      deviceName: opts.deviceName?.trim() || hostname(),
      createdAt: new Date().toISOString(),
      plugins: pluginEntries,
      mainDbSourcePath: mainDbPath,
    };
    await writeFile(join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    await tar.c({ gzip: true, file: tarFile, cwd: stageDir, portable: true }, await readdir(stageDir));

    const archiveBuffer = await readFile(tarFile);
    const checksum = createHash("sha256").update(archiveBuffer).digest("hex");

    const form = new FormData();
    form.append("archive", new Blob([archiveBuffer]), "backup.tar.gz");
    form.append("manifest", JSON.stringify({ ...manifest, checksum }));
    form.append("device_name", manifest.deviceName);

    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/agent/backup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CloudSyncError(`Backup-Upload fehlgeschlagen (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status);
    }
    const data = (await res.json()) as { data: BackupSummary };
    return { backup: data.data };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ============================================================
// Restore
// ============================================================

export interface RestoreResult {
  backup: BackupSummary;
  restartRequired: true;
}

/**
 * Laedt das neueste Backup herunter, verifiziert die Checksumme und spielt es an Ort und Stelle
 * zurueck. Schliesst dafuer alle DB-Verbindungen (Plugin-DBs + Haupt-DB-Singleton) — der
 * Aufrufer MUSS den Server-Prozess danach neu starten, bevor getDatabase() erneut aufgerufen
 * wird (auf Windows bleibt die alte Datei sonst gesperrt / der Prozess haelt noch das alte
 * Handle).
 */
export async function restoreLatestBackup(db: DatabaseService): Promise<RestoreResult> {
  const apiKey = await getDecryptedApiKey(db);
  const baseUrl = await getCloudBaseUrl(db);
  const jwt = await exchangeForJwt(baseUrl, apiKey);

  const latest = await authedJson<{ data: BackupSummary }>(db, "GET", "/api/agent/backup/latest", jwt);
  const backup = latest.data;

  const work = await mkdtemp(join(tmpdir(), "ducki-restore-"));
  const tarFile = join(work, "backup.tar.gz");
  const extractDir = join(work, "extract");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/agent/backup/${backup.id}/download`, {
        headers: { Authorization: `Bearer ${jwt}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new CloudSyncError(`Backup-Download fehlgeschlagen (HTTP ${res.status}).`, res.status);
    if (!res.body) throw new CloudSyncError("Leere Antwort beim Backup-Download.");
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tarFile));

    const archiveBuffer = await readFile(tarFile);
    const checksum = createHash("sha256").update(archiveBuffer).digest("hex");
    if (backup.checksum && checksum !== backup.checksum) {
      throw new CloudSyncError("Checksumme des heruntergeladenen Backups stimmt nicht ueberein.");
    }

    await mkdir(extractDir, { recursive: true });
    await tar.x({ file: tarFile, cwd: extractDir, preservePaths: false });

    // Alle DB-Verbindungen schliessen, bevor Dateien ueberschrieben werden.
    closeAllPluginDbs();
    resetDatabaseInstance();

    const mainDbSrc = join(extractDir, "db", "ducki.db");
    const mainDbDest = resolve(process.env["DATABASE_PATH"] ?? MAIN_DB_DEFAULT_PATH);
    if (existsSync(mainDbSrc)) {
      await mkdir(dirname(mainDbDest), { recursive: true });
      await rm(mainDbDest, { force: true });
      await cp(mainDbSrc, mainDbDest);
    }

    const pluginsSrc = join(extractDir, "plugins");
    if (existsSync(pluginsSrc)) {
      const names = await readdir(pluginsSrc, { withFileTypes: true });
      for (const entry of names) {
        if (!entry.isDirectory()) continue;
        const srcDb = join(pluginsSrc, entry.name, "data", `${entry.name}.sqlite`);
        if (!existsSync(srcDb)) continue;
        const destDir = join(pluginsRoot(), entry.name, "data");
        await mkdir(destDir, { recursive: true });
        const destDb = join(destDir, `${entry.name}.sqlite`);
        await rm(destDb, { force: true });
        await cp(srcDb, destDb);
      }
    }

    const workspaceSrc = join(extractDir, "shared-workspace");
    if (existsSync(workspaceSrc)) {
      await mkdir(SHARED_WORKSPACE_ROOT, { recursive: true });
      await cp(workspaceSrc, SHARED_WORKSPACE_ROOT, { recursive: true });
    }

    const skillsSrc = join(extractDir, "skills");
    if (existsSync(skillsSrc)) {
      const skillsRoot = resolveSkillsRoot();
      await mkdir(skillsRoot, { recursive: true });
      await cp(skillsSrc, skillsRoot, { recursive: true });
    }

    const secretKeySrc = join(extractDir, ".secret-key");
    if (existsSync(secretKeySrc)) {
      await cp(secretKeySrc, join(pluginsRoot(), ".secret-key"));
    }

    return { backup, restartRequired: true };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
