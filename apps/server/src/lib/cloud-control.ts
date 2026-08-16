/**
 * "Cloud Control" -- Fernsteuerung des Agenten ueber die Laravel-Command-Queue (siehe
 * ducki-cloud-v1 RemoteControlService). Zwei Haelften:
 *  - gatherStateSnapshot(): baut den Zustands-Spiegel (Cronjobs/Skills/Plugins/erlaubte
 *    Settings), den der Heartbeat mitschickt, damit das Dashboard etwas zum Anzeigen hat.
 *  - dispatchCommand(): fuehrt einen einzelnen, vom Dashboard gequeueten Befehl lokal aus,
 *    indem dieselben internen Funktionen aufgerufen werden, die auch die lokalen HTTP-Routen
 *    (routes/cronjobs.ts, routes/plugins.ts, routes/skills.ts) benutzen -- keine Business-Logik
 *    wird hier dupliziert.
 *
 * Bewusst standardmaessig AUS (CLOUD_CONTROL_ENABLED, Default false): erst wenn aktiv, sendet
 * der Heartbeat ueberhaupt einen state_snapshot und nimmt pendingCommands entgegen.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import type { Agent, LoadedPluginInfo } from "@ducki/agent";
import { setPluginEnabled } from "@ducki/agent";
import { installSkillFromSource } from "./skill-install.js";

export const SETTING_CLOUD_CONTROL_ENABLED = "CLOUD_CONTROL_ENABLED";

/**
 * Bewusst kuratiert -- MUSS mit RemoteControlService::ALLOWED_SETTING_KEYS im Laravel-Repo
 * uebereinstimmen. Niemals Provider-API-Keys oder andere Secrets hier aufnehmen.
 */
export const ALLOWED_SETTING_KEYS = [
  "DEFAULT_PROVIDER",
  "AGENT_MAX_ITERATIONS",
  "AGENT_ENABLE_REFLECTION",
  "AGENT_ENABLE_VERIFY",
  "AGENT_AUTO_MEMORY",
  "AGENT_AUTO_SKILL_SELECTION",
  "PLAN_MODE_ENABLED",
  "CODING_ENABLED",
];

export async function isCloudControlEnabled(db: DatabaseService): Promise<boolean> {
  return (await db.getSetting(SETTING_CLOUD_CONTROL_ENABLED)) === "true";
}

export async function setCloudControlEnabled(db: DatabaseService, enabled: boolean): Promise<void> {
  await db.setSetting(SETTING_CLOUD_CONTROL_ENABLED, enabled ? "true" : "false");
}

function resolveSkillsRoot(): string {
  const configured = process.env["SKILLS_PATH"]?.trim();
  if (configured) return join(configured);
  const monorepoCandidate = join(process.cwd(), "../../skills");
  if (existsSync(monorepoCandidate)) return monorepoCandidate;
  return join(process.cwd(), "skills");
}

function listSkillSlugs(): string[] {
  const root = resolveSkillsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")))
    .map((entry) => entry.name);
}

export interface CloudControlDeps {
  db: DatabaseService;
  getPlugins: () => LoadedPluginInfo[];
  requestPluginReload: () => void;
  createAgent: () => Promise<Agent>;
}

export interface StateSnapshot {
  cronjobs: Array<{ id: number; name: string; schedule: string; enabled: boolean; targetType: string }>;
  skills: Array<{ slug: string; name: string }>;
  plugins: Array<{ name: string; version: string; enabled: boolean }>;
  settings: Record<string, string>;
}

export async function gatherStateSnapshot(deps: CloudControlDeps): Promise<StateSnapshot> {
  const jobs = await deps.db.listCronJobs();
  const cronjobs = jobs.map((job) => ({
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    enabled: !!job.enabled,
    targetType: job.targetType,
  }));

  const skills = listSkillSlugs().map((slug) => ({ slug, name: slug }));

  const plugins = deps.getPlugins().map((plugin) => ({
    name: plugin.name,
    version: plugin.version,
    enabled: plugin.enabled,
  }));

  const settings: Record<string, string> = {};
  for (const key of ALLOWED_SETTING_KEYS) {
    const value = await deps.db.getSetting(key);
    if (value !== undefined) settings[key] = value;
  }

  return { cronjobs, skills, plugins, settings };
}

export interface PendingCommand {
  id: number;
  type: string;
  payload: Record<string, unknown> | null;
}

export interface CommandOutcome {
  status: "done" | "failed";
  result?: Record<string, unknown>;
}

/** Fuehrt einen einzelnen Befehl lokal aus. Wirft nie -- Fehler werden als 'failed' zurueckgegeben. */
export async function dispatchCommand(deps: CloudControlDeps, command: PendingCommand): Promise<CommandOutcome> {
  const payload = command.payload ?? {};
  try {
    switch (command.type) {
      case "cronjob.delete": {
        const id = Number(payload["id"]);
        if (!Number.isFinite(id)) throw new Error("cronjob.delete: 'id' fehlt oder ungueltig");
        await deps.db.deleteCronJob(id);
        return { status: "done", result: { id } };
      }

      case "cronjob.update": {
        const id = Number(payload["id"]);
        if (!Number.isFinite(id)) throw new Error("cronjob.update: 'id' fehlt oder ungueltig");
        const patch: { enabled?: number } = {};
        if (typeof payload["enabled"] === "boolean") patch.enabled = payload["enabled"] ? 1 : 0;
        const updated = await deps.db.updateCronJob(id, patch);
        if (!updated) throw new Error(`cronjob.update: Cronjob ${id} nicht gefunden`);
        return { status: "done", result: { id } };
      }

      case "skill.install": {
        const source = String(payload["source"] ?? "").trim();
        if (!source) throw new Error("skill.install: 'source' fehlt");
        const result = await installSkillFromSource({ source, skillsRoot: resolveSkillsRoot() });
        return { status: "done", result: { slug: result.slug } };
      }

      case "skill.delete": {
        const slug = String(payload["slug"] ?? "").trim();
        if (!slug) throw new Error("skill.delete: 'slug' fehlt");
        const skillDir = join(resolveSkillsRoot(), slug);
        if (!existsSync(skillDir)) throw new Error(`skill.delete: '${slug}' nicht gefunden`);
        rmSync(skillDir, { recursive: true, force: true });
        return { status: "done", result: { slug } };
      }

      case "plugin.enable":
      case "plugin.disable": {
        const name = String(payload["name"] ?? "").trim();
        if (!name) throw new Error(`${command.type}: 'name' fehlt`);
        setPluginEnabled(name, command.type === "plugin.enable");
        deps.requestPluginReload();
        return { status: "done", result: { name } };
      }

      case "setting.update": {
        const key = String(payload["key"] ?? "");
        if (!ALLOWED_SETTING_KEYS.includes(key)) throw new Error(`setting.update: '${key}' ist nicht freigegeben`);
        const value = String(payload["value"] ?? "");
        await deps.db.setSetting(key, value);
        return { status: "done", result: { key, value } };
      }

      case "chat.send": {
        const message = String(payload["message"] ?? "").trim();
        if (!message) throw new Error("chat.send: 'message' fehlt");
        const agent = await deps.createAgent();
        const conversationId = await agent.startConversation({ name: `Cloud Control: ${message.slice(0, 40)}` });
        await agent.loadConversation(conversationId);
        const runResult = await agent.run(message);
        return { status: "done", result: { reply: runResult.response, conversationId } };
      }

      default:
        throw new Error(`Unbekannter Befehlstyp: ${command.type}`);
    }
  } catch (error) {
    return { status: "failed", result: { error: error instanceof Error ? error.message : String(error) } };
  }
}
