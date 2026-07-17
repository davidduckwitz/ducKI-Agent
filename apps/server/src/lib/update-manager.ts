import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";

export interface UpdateStatus {
  enabled: boolean;
  configured: boolean;
  repoUrl: string;
  branch: string;
  workdir: string;
  intervalMinutes: number;
  requireCleanWorktree: boolean;
  checking: boolean;
  updating: boolean;
  updateAvailable: boolean;
  currentCommit?: string;
  remoteCommit?: string;
  lastCheckedAt?: string;
  lastCheckError?: string;
  lastUpdatedAt?: string;
  lastUpdateError?: string;
  lastUpdateOutput: string[];
}

interface RuntimeConfig {
  enabled: boolean;
  repoUrl: string;
  branch: string;
  intervalMinutes: number;
  requireCleanWorktree: boolean;
  workdir: string;
}

function parseBoolean(input: string | undefined, fallback: boolean): boolean {
  const normalized = (input ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseNumber(input: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function splitOutputLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function nowIso(): string {
  return new Date().toISOString();
}

export class UpdateManager {
  private status: UpdateStatus;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastIntervalTick = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger
  ) {
    const defaultWorkdir = resolve(process.cwd(), "../..");
    this.status = {
      enabled: true,
      configured: true,
      repoUrl: "https://github.com/davidduckwitz/ducKI-Agent",
      branch: "main",
      workdir: defaultWorkdir,
      intervalMinutes: 5,
      requireCleanWorktree: true,
      checking: false,
      updating: false,
      updateAvailable: false,
      lastUpdateOutput: [],
    };
  }

  snapshot(): UpdateStatus {
    return {
      ...this.status,
      lastUpdateOutput: [...this.status.lastUpdateOutput],
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.warn("Auto-update tick failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 30_000);

    void this.checkForUpdates();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (this.status.checking || this.status.updating) return this.snapshot();

    this.status.checking = true;
    this.status.lastCheckError = undefined;

    try {
      const config = await this.loadConfig();
      this.applyConfigToStatus(config);

      if (!config.enabled) {
        this.status.configured = true;
        this.status.updateAvailable = false;
        this.status.lastCheckedAt = nowIso();
        return this.snapshot();
      }

      await this.runGit(["fetch", "origin", config.branch], config.workdir, 120_000);
      const currentCommit = (await this.runGit(["rev-parse", "HEAD"], config.workdir)).stdout.trim();
      const remoteCommit = (await this.runGit(["rev-parse", `origin/${config.branch}`], config.workdir)).stdout.trim();

      this.status.currentCommit = currentCommit || undefined;
      this.status.remoteCommit = remoteCommit || undefined;
      this.status.updateAvailable = Boolean(currentCommit && remoteCommit && currentCommit !== remoteCommit);
      this.status.configured = true;
      this.status.lastCheckedAt = nowIso();
      return this.snapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.lastCheckError = message;
      this.status.configured = false;
      this.status.lastCheckedAt = nowIso();
      this.logger.warn("Update check failed", { error: message });
      return this.snapshot();
    } finally {
      this.status.checking = false;
    }
  }

  async startUpdate(): Promise<UpdateStatus> {
    if (this.status.updating) return this.snapshot();

    this.status.updating = true;
    this.status.lastUpdateError = undefined;
    this.status.lastUpdateOutput = [];

    try {
      const config = await this.loadConfig();
      this.applyConfigToStatus(config);

      if (!config.enabled) {
        this.pushOutput("Auto-update ist deaktiviert.");
        this.status.lastUpdatedAt = nowIso();
        return this.snapshot();
      }

      const checked = await this.checkForUpdates();
      if (!checked.updateAvailable) {
        this.pushOutput("Kein neues Update verfuegbar.");
        this.status.lastUpdatedAt = nowIso();
        return this.snapshot();
      }

      if (config.requireCleanWorktree) {
        const dirty = (await this.runGit(["status", "--porcelain"], config.workdir)).stdout.trim();
        if (dirty.length > 0) {
          throw new Error("Worktree ist nicht sauber. Committe oder stash lokale Aenderungen vor dem Update.");
        }
      }

      this.pushOutput(`Starte Update von origin/${config.branch} ...`);
      const pull = await this.runGit(["pull", "--ff-only", "origin", config.branch], config.workdir, 240_000);
      for (const line of splitOutputLines(`${pull.stdout}\n${pull.stderr}`)) {
        this.pushOutput(line);
      }

      await this.checkForUpdates();
      this.status.lastUpdatedAt = nowIso();
      this.pushOutput("Update abgeschlossen.");
      return this.snapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.lastUpdateError = message;
      this.status.lastUpdatedAt = nowIso();
      this.pushOutput(`Update fehlgeschlagen: ${message}`);
      this.logger.error("Manual update failed", { error: message });
      return this.snapshot();
    } finally {
      this.status.updating = false;
    }
  }

  private async tick(): Promise<void> {
    const config = await this.loadConfig();
    this.applyConfigToStatus(config);
    if (!config.enabled) return;

    const now = Date.now();
    const minDeltaMs = Math.max(1, config.intervalMinutes) * 60_000;
    if (now - this.lastIntervalTick < minDeltaMs) return;

    this.lastIntervalTick = now;
    await this.checkForUpdates();
  }

  private async loadConfig(): Promise<RuntimeConfig> {
    const rows = await this.db.getAllSettings();
    const settings = new Map(rows.map((row) => [row.key, row.value]));

    const enabled = parseBoolean(settings.get("AUTO_UPDATE_ENABLED") ?? process.env["AUTO_UPDATE_ENABLED"], true);
    const repoUrl =
      (settings.get("AUTO_UPDATE_REPO_URL") ?? process.env["AUTO_UPDATE_REPO_URL"] ?? "https://github.com/davidduckwitz/ducKI-Agent").trim();
    const branch = (settings.get("AUTO_UPDATE_BRANCH") ?? process.env["AUTO_UPDATE_BRANCH"] ?? "main").trim() || "main";
    const intervalMinutes = parseNumber(
      settings.get("AUTO_UPDATE_INTERVAL_MIN") ?? process.env["AUTO_UPDATE_INTERVAL_MIN"],
      5,
      1,
      120
    );
    const requireCleanWorktree = parseBoolean(
      settings.get("AUTO_UPDATE_REQUIRE_CLEAN_WORKTREE") ?? process.env["AUTO_UPDATE_REQUIRE_CLEAN_WORKTREE"],
      true
    );
    const workdir = resolve(
      (settings.get("AUTO_UPDATE_WORKDIR") ?? process.env["AUTO_UPDATE_WORKDIR"] ?? "../..").trim().length > 0
        ? settings.get("AUTO_UPDATE_WORKDIR") ?? process.env["AUTO_UPDATE_WORKDIR"] ?? "../.."
        : "../.."
    );

    return {
      enabled,
      repoUrl,
      branch,
      intervalMinutes,
      requireCleanWorktree,
      workdir,
    };
  }

  private applyConfigToStatus(config: RuntimeConfig): void {
    this.status.enabled = config.enabled;
    this.status.repoUrl = config.repoUrl;
    this.status.branch = config.branch;
    this.status.intervalMinutes = config.intervalMinutes;
    this.status.requireCleanWorktree = config.requireCleanWorktree;
    this.status.workdir = config.workdir;
  }

  private pushOutput(line: string): void {
    this.status.lastUpdateOutput = [...this.status.lastUpdateOutput, `[${new Date().toLocaleTimeString()}] ${line}`].slice(-120);
  }

  private runGit(
    args: string[],
    cwd: string,
    timeoutMs = 60_000
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("git", args, {
        cwd,
        windowsHide: true,
        env: process.env,
        shell: false,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        if ((code ?? 1) !== 0) {
          rejectPromise(new Error(`git ${args.join(" ")} failed (${code ?? "unknown"}): ${(stderr || stdout).trim()}`));
          return;
        }
        resolvePromise({ stdout, stderr });
      });
    });
  }
}
