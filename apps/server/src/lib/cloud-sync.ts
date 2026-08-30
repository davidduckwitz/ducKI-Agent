/**
 * Cloud-Backup/-Restore fuer selbstgehostete (BYO) Agenten gegen die ducki.cloud Laravel-API
 * (siehe `AgentBackupController` im ducki-cloud-v1 Repo). Snapshot-basiert, kein Live-Sync:
 * `createBackup()` packt Haupt-DB, alle Plugin-DBs, das Shared-Workspace und den Skills-Ordner
 * in ein tar.gz und laedt es hoch; `restoreBackup()` laedt ein Backup (per ID oder das neueste)
 * herunter und spielt es an Ort und Stelle zurueck.
 *
 * Auth: wiederverwendet die bestehenden Wave-API-Keys aus /settings/api (POST /api/token
 * tauscht den Key gegen ein 1h-JWT). Der API-Key wird AES-256-GCM-verschluesselt (wie
 * Plugin-Secrets) unter der Setting "CLOUD_API_KEY" in der Haupt-DB abgelegt.
 *
 * Restore ueberschreibt Dateien, die evtl. gerade von der laufenden Server-Instanz offen
 * gehalten werden (Haupt-DB, Plugin-DBs). Dafuer schliesst restoreBackup() vor dem
 * Zurueckspielen alle DB-Verbindungen (closeAllPluginDbs + resetDatabaseInstance); der Aufrufer
 * (Route-Handler) muss den Prozess danach neu starten (Windows haelt offene SQLite-Dateien
 * gesperrt, ein Hot-Swap ist nicht sicher moeglich).
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm, cp, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import * as tar from "tar";
import { getRootLogger } from "@ducki/logger";
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
import { skillsRoot as resolveSkillsRoot } from "@ducki/shared";

const logger = getRootLogger().child("CloudSync");

const SETTING_API_KEY = "CLOUD_API_KEY";
const SETTING_BASE_URL = "CLOUD_BASE_URL";
const DEFAULT_BASE_URL = "https://ducki.cloud";
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAIN_DB_DEFAULT_PATH = "./storage/ducki.db";
/** Server-Hardcap ist 500MB (siehe AgentBackupController `archive => max:512000`); mit Puffer. */
const MAX_ARCHIVE_BYTES = 480 * 1024 * 1024;
/**
 * Top-level Ordner unter shared-workspace, die reine, jederzeit neu erzeugbare Scratch-/
 * Cache-Daten sind und beim Backup nicht mitgezogen werden sollen. bitcoin-puzzle-attempts
 * (packages/agent/src/crypto/bitcoin-puzzle-service.ts) kann alleine >500MB an CSV-Logs
 * anhaeufen und liess das Backup vorher endlos haengen (voller rekursiver Kopiervorgang +
 * gzip ueber teils 800MB grosse Einzeldateien, ohne dass der Upload je den Server erreichte).
 * voice-uploads (cloud-control.ts) sind Chat-Bildanhaenge, die nach jeder Analyse sofort
 * wieder geloescht werden -- der Eintrag hier ist nur ein Sicherheitsnetz falls das Loeschen
 * mal fehlschlaegt, kein regulaerer Zustand.
 */
const EXCLUDED_WORKSPACE_DIRS = new Set(["bitcoin-puzzle-attempts", "voice-uploads"]);

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

export interface HeartbeatPendingCommand {
  id: number;
  type: string;
  payload: Record<string, unknown> | null;
}

/**
 * Lebenszeichen an die Cloud senden (Geraetename + Version), damit das Dashboard "online seit X"
 * zeigen kann. stateSnapshot ist optional -- nur mitschicken, wenn Cloud Control lokal aktiv
 * ist (siehe cloud-control.ts). Gibt die vom Server ausgelieferten offenen Befehle zurueck
 * (leer, wenn der Server sie nicht ausliefert, z.B. weil die Capability fehlt).
 */
export async function sendHeartbeat(
  db: DatabaseService,
  opts: { stateSnapshot?: Record<string, unknown> } = {}
): Promise<HeartbeatPendingCommand[]> {
  const apiKey = await getDecryptedApiKey(db);
  const baseUrl = await getCloudBaseUrl(db);
  const jwt = await exchangeForJwt(baseUrl, apiKey);
  const version = await readAgentVersion();
  const response = await authedJson<{ data: { pendingCommands?: HeartbeatPendingCommand[] } }>(
    db,
    "POST",
    "/api/agent/heartbeat",
    jwt,
    {
      device_name: hostname(),
      agent_version: version,
      ...(opts.stateSnapshot ? { state_snapshot: opts.stateSnapshot } : {}),
    }
  );
  return response.data.pendingCommands ?? [];
}

/**
 * Dedizierter, schneller Poll-Kanal fuer Voice-Chat-Befehle (siehe cloud-voice.ts) --
 * unabhaengig vom trägen Heartbeat-Intervall (Default 3 Min.), damit ein Chat in der
 * Voice-App sich wie ein echtes Gespraech anfuehlt statt wie ein Ticket-System. Liefert NUR
 * `chat.send`/`voice.transcribe` aus (Laravel-seitig gefiltert), alle anderen Cloud-Control-
 * Befehlstypen bleiben exklusiv beim normalen Heartbeat.
 */
export async function pollVoiceCommands(db: DatabaseService): Promise<HeartbeatPendingCommand[]> {
  const apiKey = await getDecryptedApiKey(db);
  const baseUrl = await getCloudBaseUrl(db);
  const jwt = await exchangeForJwt(baseUrl, apiKey);
  const response = await authedJson<{ data: { pendingCommands?: HeartbeatPendingCommand[] } }>(
    db,
    "POST",
    "/api/agent/voice/poll",
    jwt
  );
  return response.data.pendingCommands ?? [];
}

/** Ergebnis eines per Cloud Control ausgefuehrten Befehls zurueckmelden. */
export async function reportCommandResult(
  db: DatabaseService,
  commandId: number,
  status: "done" | "failed",
  result?: Record<string, unknown>
): Promise<void> {
  const apiKey = await getDecryptedApiKey(db);
  const baseUrl = await getCloudBaseUrl(db);
  const jwt = await exchangeForJwt(baseUrl, apiKey);
  await authedJson(db, "POST", `/api/agent/commands/${commandId}/result`, jwt, { status, result });
}

export interface PushNotificationResult {
  sent: number;
  failed: number;
  reason?: string;
}

/**
 * Schickt eine Browser-Push-Benachrichtigung an alle Voice-App-Subscriptions des Nutzers (siehe
 * PushNotificationController::send() im ducki-cloud-v1-Repo) - z.B. wenn eine lang laufende
 * Aufgabe fertig ist, waehrend die Voice-App-Seite nicht offen/fokussiert ist. Derselbe
 * JWT-Austausch wie jeder andere Cloud-Control-Call; wirft CloudSyncError, wenn kein Cloud-
 * API-Key hinterlegt ist oder der Server nicht erreichbar ist - der Aufrufer (push-notification-
 * tool.ts) behandelt das als "nicht verfuegbar", nicht als harten Fehler.
 */
export async function sendPushNotification(
  db: DatabaseService,
  title: string,
  body: string,
  url?: string
): Promise<PushNotificationResult> {
  const apiKey = await getDecryptedApiKey(db);
  const baseUrl = await getCloudBaseUrl(db);
  const jwt = await exchangeForJwt(baseUrl, apiKey);
  return authedJson<PushNotificationResult>(db, "POST", "/api/agent/push/send", jwt, { title, body, url });
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
  logger.info("Backup gestartet", { deviceName: opts.deviceName });
  try {
    await mkdir(join(stageDir, "db"), { recursive: true });
    await mkdir(join(stageDir, "plugins"), { recursive: true });

    // Haupt-DB: konsistenter Snapshot via VACUUM INTO.
    const mainDbPath = resolve(process.env["DATABASE_PATH"] ?? MAIN_DB_DEFAULT_PATH);
    await db.vacuumInto(join(stageDir, "db", "ducki.db"));

    // Plugin-DBs.
    const pluginEntries = await snapshotPluginDbs(join(stageDir, "plugins"));

    // Shared-Workspace (enthaelt bereits coding/ als Unterordner). Bekannte Scratch-/
    // Cache-Ordner (siehe EXCLUDED_WORKSPACE_DIRS) werden uebersprungen.
    if (existsSync(SHARED_WORKSPACE_ROOT)) {
      await cp(SHARED_WORKSPACE_ROOT, join(stageDir, "shared-workspace"), {
        recursive: true,
        filter: (src) => {
          const rel = src.slice(SHARED_WORKSPACE_ROOT.length).replace(/^[\\/]+/, "");
          const topLevel = rel.split(/[\\/]/)[0];
          return !topLevel || !EXCLUDED_WORKSPACE_DIRS.has(topLevel);
        },
      });
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
      excludedWorkspaceDirs: [...EXCLUDED_WORKSPACE_DIRS],
    };
    await writeFile(join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    await tar.c({ gzip: true, file: tarFile, cwd: stageDir, portable: true }, await readdir(stageDir));

    const archiveSize = (await stat(tarFile)).size;
    logger.info("Archiv erstellt", { archiveSize });
    if (archiveSize > MAX_ARCHIVE_BYTES) {
      throw new CloudSyncError(
        `Backup zu gross (${(archiveSize / 1048576).toFixed(0)} MB, Limit ${(MAX_ARCHIVE_BYTES / 1048576).toFixed(0)} MB). ` +
          `Grosse Dateien im Shared-Workspace pruefen (z.B. shared-workspace/*.csv oder generierte Dumps).`
      );
    }

    const archiveBuffer = await readFile(tarFile);
    const checksum = createHash("sha256").update(archiveBuffer).digest("hex");

    const form = new FormData();
    form.append("archive", new Blob([archiveBuffer]), "backup.tar.gz");
    form.append("manifest", JSON.stringify({ ...manifest, checksum }));
    form.append("device_name", manifest.deviceName);

    logger.info("Lade Backup hoch", { archiveSize });
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
    logger.info("Backup abgeschlossen", { backupId: data.data.id, archiveSize });
    return { backup: data.data };
  } catch (error) {
    logger.error("Backup fehlgeschlagen", { error: error instanceof Error ? error.message : String(error) });
    throw error;
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
 * Laedt ein Backup herunter (per opts.backupId eine bestimmte Version, sonst das neueste),
 * verifiziert die Checksumme und spielt es an Ort und Stelle zurueck. Schliesst dafuer alle
 * DB-Verbindungen (Plugin-DBs + Haupt-DB-Singleton) — der Aufrufer MUSS den Server-Prozess
 * danach neu starten, bevor getDatabase() erneut aufgerufen wird (auf Windows bleibt die alte
 * Datei sonst gesperrt / der Prozess haelt noch das alte Handle).
 */
export async function restoreBackup(db: DatabaseService, opts: { backupId?: number } = {}): Promise<RestoreResult> {
  const apiKey = await getDecryptedApiKey(db);
  const baseUrl = await getCloudBaseUrl(db);
  const jwt = await exchangeForJwt(baseUrl, apiKey);

  const path = opts.backupId ? `/api/agent/backup/${opts.backupId}` : "/api/agent/backup/latest";
  const selected = await authedJson<{ data: BackupSummary }>(db, "GET", path, jwt);
  const backup = selected.data;

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
