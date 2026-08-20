import "dotenv/config";
import "./bootstrap-workspace.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { Server as SocketIOServer } from "socket.io";
import {
	Agent,
	WorkflowEngine,
	createWorkflowManagementTool,
	createWorkflowTools,
	createCronjobManagementTool,
	Executor,
	createDynamicToolResolver,
	createToolFactoryTool,
	createCodingAgent,
	type CodingAgent,
	createScriptTools,
} from "@ducki/agent";
import { getDatabase, type DatabaseService, getPluginSettings, setPluginSetting } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { MCPRegistry, type MCPServerConfig } from "@ducki/mcp";
import type { ToolExecutor } from "@ducki/shared";
import { createProvider, type ProviderName } from "@ducki/providers";
import { allTools, browserFrameEvents } from "@ducki/tools";
import { errorHandler } from "./middleware/error-handler.js";
import { ConnectorRegistry } from "./lib/connector-registry.js";
import { agentRegistry } from "./lib/agent-registry.js";
import { CronjobManager } from "./lib/cronjob-manager.js";
import { createMcpTool } from "./lib/mcp-tool.js";
import { UpdateManager } from "./lib/update-manager.js";
import { setupDefaultCronjobs } from "./lib/default-cronjobs.js";
import { LlmWikiService } from "./lib/llm-wiki-service.js";
import { CloudBackupScheduler } from "./lib/cloud-backup-scheduler.js";
import { CloudHeartbeatService } from "./lib/cloud-heartbeat.js";
import { createWikiTool } from "./lib/wiki-tool.js";
import { PromptManager } from "./lib/prompt-manager.js";
import {
	initToolStagingManager,
	initToolResponseHandler,
	getToolStagingManager,
	createToolStagingTool,
} from "./lib/tool-staging/index.js";
import { initChatToolEventBroadcaster } from "./lib/chat-tool-events.js";
import { wrapTools } from "./lib/tool-wrapper.js";
import { initScreenshotStorage } from "./lib/screenshot-storage.js";
import { agentsRouter } from "./routes/agents.js";
import { chatRouter } from "./routes/chat.js";
import { cronjobsRouter } from "./routes/cronjobs.js";
import { codingRouter, CODING_ROOT } from "./routes/coding.js";
import { codingAgentRouter } from "./routes/coding-agent.js";
import { gatewayRouter } from "./routes/gateway.js";
import { logsRouter } from "./routes/logs.js";
import { mcpRouter } from "./routes/mcp.js";
import { memoryRouter } from "./routes/memory.js";
import { plansRouter } from "./routes/plans.js";
import { pluginsRouter } from "./routes/plugins.js";
import { pluginOAuthRouter } from "./routes/plugin-oauth.js";
import { PluginManager } from "./lib/plugin-manager.js";
import { projectsRouter } from "./routes/projects.js";
import { settingsRouter } from "./routes/settings.js";
import { syncRouter } from "./routes/sync.js";
import { credentialRouter, setupCredentialRoutes } from "./routes/credentials.js";
import { sharedRouter } from "./routes/shared.js";
import { skillsRouter } from "./routes/skills.js";
import { tasksRouter } from "./routes/tasks.js";
import { toolsRouter } from "./routes/tools.js";
import { updatesRouter } from "./routes/updates.js";
import { workflowsRouter } from "./routes/workflows.js";
import { wikiRouter } from "./routes/wiki.js";
import { createCryptoPaymentRouter } from "./routes/crypto-payment.js";
import { createToolStagingRouter } from "./routes/tool-staging.js";
import { screenshotRouter } from "./routes/screenshots.js";
import { bitcoinPuzzleRouter } from "./routes/bitcoin-puzzle.js";
import { createProviderModelsRouter } from "./routes/provider-models.js";
import { createCryptoPaymentMcpTool } from "./crypto/mcp-crypto-server.js";
import { createTasksMcpTool } from "./tasks/mcp-tasks-server.js";
import { createWorkflowMcpTool } from "./workflow/mcp-workflow-server.js";
import { createCronjobsMcpTool } from "./cronjobs/mcp-cronjobs-server.js";
import {
	setupWebSocket,
	broadcastServerShutdown,
	broadcastSettingsChanged,
	SERVER_PROTOCOL_VERSION,
} from "./websocket/index.js";

const logger = getRootLogger().child("Server");

type RequestWithRawBody = express.Request & { rawBody?: string };

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listenWithRetry(httpServer: ReturnType<typeof createServer>, host: string, port: number): Promise<void> {
	const attempts = Number.parseInt(process.env["SERVER_LISTEN_RETRIES"] ?? "20", 10);
	const retryDelayMs = Number.parseInt(process.env["SERVER_LISTEN_RETRY_DELAY_MS"] ?? "250", 10);

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					httpServer.off("listening", onListening);
					reject(error);
				};
				const onListening = () => {
					httpServer.off("error", onError);
					resolve();
				};

				httpServer.once("error", onError);
				httpServer.once("listening", onListening);
				httpServer.listen(port, host);
			});
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			const isLastAttempt = attempt >= attempts;
			if (code !== "EADDRINUSE" || isLastAttempt) {
				throw error;
			}
			logger.warn("Port busy during restart, retrying listen", {
				host,
				port,
				attempt,
				attempts,
				retryDelayMs,
			});
			await sleep(retryDelayMs);
		}
	}
}

function normalizeApiKey(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const normalized = trimmed.replace(/^Bearer\s+/i, "").trim();
	if (!normalized) return undefined;
	const lowered = normalized.toLowerCase();
	if (["lm-studio", "not-needed", "none", "null", "undefined"].includes(lowered)) {
		return undefined;
	}
	return normalized;
}

function readSettingValue(
	settings: Map<string, string>,
	key: string,
	envKey?: string,
	fallback?: string
): string | undefined {
	const fromSettings = settings.get(key)?.trim();
	if (fromSettings) return fromSettings;
	if (envKey) {
		const fromEnv = process.env[envKey]?.trim();
		if (fromEnv) return fromEnv;
	}
	if (fallback && fallback.trim()) return fallback;
	return undefined;
}

function parseProviderName(value: string | undefined): ProviderName {
	const normalized = value?.trim().toLowerCase();
	if (
		normalized === "openai" ||
		normalized === "openrouter" ||
		normalized === "ollama" ||
		normalized === "lmstudio" ||
		normalized === "claude" ||
		normalized === "nous"
	) {
		return normalized;
	}
	return "lmstudio";
}

async function ensureLogCleanupCron(db: Awaited<ReturnType<typeof getDatabase>>): Promise<void> {
	try {
		const existing = await db.listCronJobs();
		if (existing.find(j => j.name === "log-cleanup-daily")) {
			return;
		}

		await db.createCronJob({
			name: "log-cleanup-daily",
			schedule: "0 2 * * *",
			targetType: "tool",
			targetRef: "logs",
			payload: JSON.stringify({ action: "cleanup", maxEntries: 100 }),
			enabled: 1,
		});

		logger.info("Log cleanup cron job created", { schedule: "0 2 * * * (2 AM daily)" });
	} catch (error) {
		logger.warn("Failed to create log cleanup cron job", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * One-time migration (plan section 7): if the legacy MESSAGING_GATEWAYS setting still has a
 * plaintext Discord entry with a bot token and the discord-connector plugin has no authToken of
 * its own yet, seed the plugin's encrypted settings store from it - a full 1:1 field mapping of
 * the old MessagingGatewayConfig shape (routes/gateway.ts) onto the plugin's settings[] (see
 * plugin.json): name, authToken(secret), channelHint, inboundLabel, guildId, userId, appId,
 * publicKey, metadata, webhookSecret(secret). Never overwrites an existing plugin setting, and
 * never throws (a failed migration must not block boot). The legacy setting itself is left in
 * place (other portals, e.g. telegram/custom webhooks, still read it) - only the Discord entry
 * is superseded once the connector plugin has its own configured token.
 */
async function migrateLegacyDiscordGatewaySettings(db: Awaited<ReturnType<typeof getDatabase>>): Promise<void> {
	try {
		const raw = await db.getSetting("MESSAGING_GATEWAYS");
		if (!raw) return;
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return;
		const discordEntry = parsed.find(
			(entry) => entry && typeof entry === "object" && String((entry as Record<string, unknown>)["portal"] ?? "").toLowerCase() === "discord"
				&& String((entry as Record<string, unknown>)["authToken"] ?? "").trim()
		) as Record<string, unknown> | undefined;
		if (!discordEntry) return;

		const specs = [
			{ key: "name", type: "string" as const },
			{ key: "authToken", type: "secret" as const },
			{ key: "channelHint", type: "string" as const },
			{ key: "inboundLabel", type: "string" as const },
			{ key: "guildId", type: "string" as const },
			{ key: "userId", type: "string" as const },
			{ key: "appId", type: "string" as const },
			{ key: "publicKey", type: "string" as const },
			{ key: "metadata", type: "string" as const },
			{ key: "webhookSecret", type: "secret" as const },
		];
		const existing = await getPluginSettings("discord-connector", specs);
		if (existing["authToken"]) return; // plugin already has its own token - never overwrite

		// Full 1:1 field mapping - every field the old Discord gateway config form exposed.
		const fieldMap: Array<[key: string, legacyKey: string]> = [
			["name", "name"],
			["authToken", "authToken"],
			["channelHint", "channelHint"],
			["inboundLabel", "inboundLabel"],
			["guildId", "guildId"],
			["userId", "userId"],
			["appId", "appId"],
			["publicKey", "publicKey"],
			["metadata", "metadata"],
			["webhookSecret", "webhookSecret"],
		];
		for (const [key, legacyKey] of fieldMap) {
			const value = discordEntry[legacyKey];
			if (value !== undefined && value !== null && String(value).trim()) {
				await setPluginSetting("discord-connector", key, String(value), specs);
			}
		}
		logger.info("Migrated legacy MESSAGING_GATEWAYS Discord config into discord-connector plugin settings");
	} catch (error) {
		logger.warn("Legacy Discord gateway settings migration failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function loadProviderFromSettings(db: Awaited<ReturnType<typeof getDatabase>>) {
	const allSettings = await db.getAllSettings();
	const settingMap = new Map(allSettings.map((entry) => [entry.key, entry.value]));
	const providerName = parseProviderName(
		readSettingValue(settingMap, "DEFAULT_PROVIDER", "DEFAULT_PROVIDER", "lmstudio")
	);

	if (providerName === "lmstudio") {
		const rawApiKey = readSettingValue(settingMap, "LM_STUDIO_API_KEY", "LM_STUDIO_API_KEY");
		const normalizedKey = normalizeApiKey(rawApiKey);
		console.log("[DEBUG loadProviderFromSettings] LM Studio config:", {
			hasRawApiKey: !!rawApiKey,
			rawKeyLength: rawApiKey?.length ?? 0,
			hasNormalizedKey: !!normalizedKey,
			normalizedKeyLength: normalizedKey?.length ?? 0,
		});
		const provider = createProvider({
			name: "lmstudio",
			baseUrl: readSettingValue(settingMap, "LM_STUDIO_BASE_URL", "LM_STUDIO_BASE_URL", "http://localhost:1234/v1"),
			model: readSettingValue(settingMap, "LM_STUDIO_MODEL", "LM_STUDIO_MODEL", "local-model"),
			apiKey: normalizedKey,
		});
		return { provider, providerName };
	}

	if (providerName === "openrouter") {
		const provider = createProvider({
			name: "openrouter",
			baseUrl: readSettingValue(settingMap, "OPENROUTER_BASE_URL", "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
			model: readSettingValue(settingMap, "OPENROUTER_MODEL", "OPENROUTER_MODEL", "anthropic/claude-3-5-sonnet"),
			apiKey: normalizeApiKey(readSettingValue(settingMap, "OPENROUTER_API_KEY", "OPENROUTER_API_KEY")),
		});
		return { provider, providerName };
	}

	if (providerName === "openai") {
		const provider = createProvider({
			name: "openai",
			baseUrl: readSettingValue(settingMap, "OPENAI_BASE_URL", "OPENAI_BASE_URL", "https://api.openai.com/v1"),
			model: readSettingValue(settingMap, "OPENAI_MODEL", "OPENAI_MODEL", "gpt-4o"),
			apiKey: normalizeApiKey(readSettingValue(settingMap, "OPENAI_API_KEY", "OPENAI_API_KEY")),
		});
		return { provider, providerName };
	}

	if (providerName === "claude") {
		const rawKey = readSettingValue(settingMap, "CLAUDE_API_KEY", "CLAUDE_API_KEY");
		const normalizedKey = normalizeApiKey(rawKey);
		console.log("[DEBUG loadProviderFromSettings] Claude config:", {
			hasRawApiKey: !!rawKey,
			rawKeyLength: rawKey?.length ?? 0,
			hasNormalizedKey: !!normalizedKey,
			normalizedKeyLength: normalizedKey?.length ?? 0,
			normalizedKeyStart: normalizedKey?.substring(0, 20) ?? "none",
			baseUrl: "https://api.anthropic.com/v1",
			model: readSettingValue(settingMap, "CLAUDE_MODEL", "CLAUDE_MODEL", "claude-3-5-sonnet-20241022"),
		});
		const provider = createProvider({
			name: "claude",
			baseUrl: readSettingValue(settingMap, "CLAUDE_BASE_URL", "CLAUDE_BASE_URL", "https://api.anthropic.com/v1"),
			model: readSettingValue(settingMap, "CLAUDE_MODEL", "CLAUDE_MODEL", "claude-3-5-sonnet-20241022"),
			apiKey: normalizedKey,
		});
		return { provider, providerName };
	}

	if (providerName === "nous") {
		const provider = createProvider({
			name: "nous",
			baseUrl: readSettingValue(settingMap, "NOUS_BASE_URL", "NOUS_BASE_URL"),
			model: readSettingValue(settingMap, "NOUS_MODEL", "NOUS_MODEL"),
			apiKey: normalizeApiKey(readSettingValue(settingMap, "NOUS_API_KEY", "NOUS_API_KEY")),
		});
		return { provider, providerName };
	}

	const provider = createProvider({
		name: "ollama",
		baseUrl: readSettingValue(settingMap, "OLLAMA_BASE_URL", "OLLAMA_BASE_URL", "http://localhost:11434"),
		model: readSettingValue(settingMap, "OLLAMA_MODEL", "OLLAMA_MODEL", "llama3"),
	});
	return { provider, providerName };
}

const MCP_SERVERS_SETTING = "MCP_SERVERS";

function parseMcpServerConfigs(raw: string | undefined): MCPServerConfig[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((item) => item && typeof item === "object")
			.map((item, index) => {
				const entry = item as Record<string, unknown>;
				return {
					id: String(entry["id"] ?? `mcp_${index + 1}`).trim(),
					name: String(entry["name"] ?? `MCP ${index + 1}`).trim(),
					url: String(entry["url"] ?? "").trim(),
					enabled: entry["enabled"] !== false,
				};
			})
			.filter((entry) => entry.id.length > 0 && entry.name.length > 0 && entry.url.length > 0);
	} catch {
		return [];
	}
}

/**
 * Every built-in tool is always registered here, regardless of
 * ENABLED_OPTIONAL_TOOLS - registration only decides what a tool *is*, not
 * whether it's usable. Whether a disabled tool can actually run is enforced
 * at the point of execution instead (Agent.preflightToolInput for the chat
 * path, WorkflowEngine.executeToolCallNode for workflow/cronjob dispatch),
 * both re-checking the setting fresh every time. Keeping registration
 * unconditional is what lets `GET /api/tools` (and the Tools settings page)
 * list every tool - including ones nobody has enabled yet - so a disabled
 * tool can actually be discovered and turned on.
 */
function buildAgentFactory(
	providerRef: { current: ReturnType<typeof createProvider> },
	db: Awaited<ReturnType<typeof getDatabase>>,
	workflowEngineRef: { current: WorkflowEngine },
	runtimeTools: ToolExecutor[],
	wikiServiceRef: { current?: LlmWikiService },
	pluginManager: PluginManager,
	connectorRegistryProxy: import("@ducki/agent").ConnectorRegistryLike,
	promptManager: PromptManager
) {
	return async () => {
		// Load database settings for agent configuration
		const maxIterationsSetting = await db.getSetting("AGENT_MAX_ITERATIONS");
		console.log("[buildAgentFactory] Loading agent settings", {
			maxIterationsSetting,
			parsed: maxIterationsSetting ? parseInt(maxIterationsSetting) : undefined,
		});
		// The Memory settings UI lets a user edit system.md via PromptManager - without this it
		// was a dead letter, saved to the DB/file but never read back into any Agent instance.
		const customSystemPrompt = await promptManager.getPrompt("system");
		const agentOptions = {
			...(maxIterationsSetting ? { maxIterations: parseInt(maxIterationsSetting) } : {}),
			...(customSystemPrompt.trim() ? { systemPrompt: customSystemPrompt } : {}),
		};

		const agent = new Agent(providerRef.current, db, undefined, agentOptions);
		// Wrap tools to broadcast events and handle response staging
		const wrappedTools = wrapTools(runtimeTools);
		for (const tool of wrappedTools) {
			agent.executor.registerTool(tool);
		}
		// Plugin tools are registered here (per request) from the PluginManager's CURRENT set,
		// so enable/disable/install take effect for the NEXT agent without touching running ones.
		for (const tool of wrapTools(pluginManager.getTools())) {
			agent.executor.registerTool(tool);
		}
		agent.executor.registerTool(createWorkflowManagementTool(workflowEngineRef.current));
		agent.executor.registerTool(createCronjobManagementTool(db));
		agent.executor.registerTool(createToolFactoryTool(db, agent.executor));
		agent.executor.registerTool(createWikiTool(() => wikiServiceRef.current));
		// Registered unwrapped on purpose: wrapTools would stage this tool's own chunks.
		agent.executor.registerTool(createToolStagingTool(() => getToolStagingManager()));
		for (const tool of createWorkflowTools(db, connectorRegistryProxy)) {
			agent.executor.registerTool(tool);
		}
		return agent;
	};
}

function registerRoutes(app: express.Express, database: DatabaseService): void {
	app.use("/api/chat", chatRouter);
	app.use("/api/tasks", tasksRouter);
	app.use("/api/projects", projectsRouter);
	app.use("/api/plans", plansRouter);
	app.use("/api/plugins", pluginsRouter);
	app.use("/api/plugins", pluginOAuthRouter);
	app.use("/api/tools", toolsRouter);
	app.use("/api/memory", memoryRouter);
	app.use("/api/settings", settingsRouter);
	app.use("/api/sync", syncRouter);
	app.use("/api/provider-models", createProviderModelsRouter(database));
	app.use("/api/crypto", createCryptoPaymentRouter(database));
	app.use("/api/bitcoin-puzzle", bitcoinPuzzleRouter);
	setupCredentialRoutes(database);
	app.use("/api/credentials", credentialRouter);
	app.use("/api/logs", logsRouter);
	app.use("/api/agents", agentsRouter);
	app.use("/api/skills", skillsRouter);
	app.use("/api/shared", sharedRouter);
	app.use("/api/updates", updatesRouter);
	app.use("/api/cronjobs", cronjobsRouter);
	app.use("/api/coding", codingRouter);
	app.use("/api/coding-agent", codingAgentRouter);
	app.use("/api/workflows", workflowsRouter);
	app.use("/api/gateway", gatewayRouter);
	app.use("/api/mcp", mcpRouter);
	app.use("/api/tool-staging", createToolStagingRouter());
	app.use("/api/screenshots", screenshotRouter);
	app.use("/api/wiki", wikiRouter);
}

async function bootstrap(): Promise<void> {
	const app = express();
	// Raise the HTTP header limit well above Node's ~16KB default. Requests in the screenshot
	// flow (e.g. an <img>/GET to /api/screenshots/:id or /api/shared/view carrying accumulated
	// cookies, or a tool-driven request that mistakenly puts base64 image data in a header)
	// can intermittently push total request headers past 16KB, which Node rejects with HTTP 431
	// "Request Header Fields Too Large" before Express ever runs. 64KB is generous while still
	// bounding abuse. Screenshot BYTES still travel in the body/URL path, never in headers.
	const httpServer = createServer({ maxHeaderSize: 64 * 1024 }, app);

	app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

	// Chrome "Private Network Access": a public/secure page (e.g. the deployed landing
	// UI served over https) reaching this backend on a local/private address
	// (127.0.0.1, 192.168.x, …) triggers a preflight that the browser blocks unless the
	// server explicitly opts in with this header. Without it, "Verbindung testen" and
	// the socket handshake fail even though CORS is otherwise open.
	app.use((req, res, next) => {
		if (req.headers["access-control-request-private-network"]) {
			res.setHeader("Access-Control-Allow-Private-Network", "true");
		}
		next();
	});

	app.use(
		cors({
			origin: process.env["CORS_ORIGIN"] ?? "*",
			methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
			credentials: true,
		})
	);

	app.use(
		express.json({
			limit: "50mb",
			verify: (req, _res, buf) => {
				(req as RequestWithRawBody).rawBody = Buffer.from(buf).toString("utf8");
			},
		})
	);
	app.use(express.urlencoded({ extended: true }));

	const db = await getDatabase();
	await migrateLegacyDiscordGatewaySettings(db);

	// Initialize tool staging (hybrid approach: large responses → files, summaries → messages)
	const toolStagingManager = await initToolStagingManager(logger.child("ToolStaging"));
	const toolResponseHandler = initToolResponseHandler(logger.child("ToolResponseHandler"), toolStagingManager);

	// Initialize screenshot storage (large screenshots → files, summaries → inline)
	const screenshotStorage = await initScreenshotStorage();

	// Generic connector registry (Discord etc.). Created near the end of bootstrap (needs `port`
	// for its inbound loopback URL - see below), but agent/workflow tool wiring needs a stable
	// reference NOW, so a thin proxy forwards to whatever gets assigned to this ref later. Same
	// mutable-holder pattern the old discordGatewayStatus object used.
	const connectorRegistryRef: { current?: ConnectorRegistry } = {};
	const connectorRegistryProxy: import("@ducki/agent").ConnectorRegistryLike = {
		list: () => connectorRegistryRef.current?.list() ?? [],
		hasConnector: (portal: string) => connectorRegistryRef.current?.hasConnector(portal) ?? false,
		send: (portal, target, message) => {
			if (!connectorRegistryRef.current) {
				return Promise.reject(new Error(`Connector registry not ready yet (portal '${portal}')`));
			}
			return connectorRegistryRef.current.send(portal, target, message);
		},
	};

	const loadedProvider = await loadProviderFromSettings(db);
	const provider = loadedProvider.provider;
	logger.info("Provider loaded", { provider: loadedProvider.providerName });
	const mcpRegistry = new MCPRegistry();
	const mcpServers = parseMcpServerConfigs(await db.getSetting(MCP_SERVERS_SETTING));
	await mcpRegistry.syncServers(mcpServers);
	// File-first plugins (plugins/<name>/): the PluginManager owns the current tool set and
	// hot-reloads it on enable/disable/install WITHOUT interrupting running agents (it defers
	// the swap until no agent is active). Per-request agents register these via the factory.
	const pluginManager = await PluginManager.create();
	logger.info("Plugins loaded at startup", {
		enabled: pluginManager.getPlugins().filter((p) => p.enabled && !p.error).length,
		tools: pluginManager.getTools().length,
	});
	const runtimeTools: ToolExecutor[] = [
		...allTools,
		createMcpTool(mcpRegistry),
		createCryptoPaymentMcpTool(db),
		// Browser automation is handled by the real `browser` tool (in allTools, Puppeteer in an
		// isolated worker) plus the browser-control SKILL. A former `browser-control` MCP stub was
		// removed: it returned a 1x1 mock screenshot yet reported success, so the model picked it
		// over the real tool and "browsed" nothing.
		createTasksMcpTool(db),
		createWorkflowMcpTool(db),
		createCronjobsMcpTool(db),
	];
	const providerRef: { current: ReturnType<typeof createProvider> } = { current: provider };

	// Persistent Executor dedicated to the WorkflowEngine (tool_call nodes dispatch
	// through it directly), wired with the same DB-backed dynamic tool resolver used
	// by every per-request Agent so dynamically registered tools resolve everywhere.
	const workflowExecutor = new Executor(logger.child("WorkflowExecutor"), createDynamicToolResolver(db));
	// Wrap tools for event broadcasting and response staging
	const wrappedRuntimeTools = wrapTools(runtimeTools);
	for (const tool of wrappedRuntimeTools) {
		workflowExecutor.registerTool(tool);
	}
	// Plugin tools for the persistent workflow executor are wired once at boot; workflows pick
	// up plugin enable/disable on the next server start (the per-request chat agent hot-reloads).
	for (const tool of wrapTools(pluginManager.getTools())) {
		workflowExecutor.registerTool(tool);
	}
	workflowExecutor.registerTool(createCronjobManagementTool(db));
	workflowExecutor.registerTool(createToolFactoryTool(db, workflowExecutor));
	// Registered unwrapped on purpose: wrapTools would stage this tool's own chunks.
	workflowExecutor.registerTool(createToolStagingTool(() => getToolStagingManager()));
	// Boot-time only: a script-backed tools/<name>/TOOL.md added later reaches workflow/cronjob
	// dispatch after a restart, same trade-off already accepted for MCP_SERVERS in this bootstrap.
	for (const tool of createScriptTools(() => providerRef.current, logger.child("ScriptTools"))) {
		workflowExecutor.registerTool(tool);
	}

	const createCodingAgentFactory = (options?: { sandboxRoot?: string; maxIterations?: number; eventEmitter?: any }): CodingAgent => {
		// If sandboxRoot is provided, combine it with CODING_ROOT
		// Frontend sends just the project slug, server combines it with CODING_ROOT
		let resolvedSandboxRoot = CODING_ROOT;
		if (options?.sandboxRoot) {
			resolvedSandboxRoot = resolve(CODING_ROOT, options.sandboxRoot);
		}
		return createCodingAgent(providerRef.current, db, options?.eventEmitter, {
			sandboxRoot: resolvedSandboxRoot,
			maxIterations: options?.maxIterations,
		});
	};

	const workflowEngineRef: { current: WorkflowEngine } = {
		current: new WorkflowEngine(providerRef.current, db, workflowExecutor, {
			logger: logger.child("WorkflowEngine"),
			codingAgentFactory: () => createCodingAgentFactory(),
		}),
	};
	workflowExecutor.registerTool(createWorkflowManagementTool(workflowEngineRef.current));
	for (const tool of createWorkflowTools(db, connectorRegistryProxy)) {
		workflowExecutor.registerTool(tool);
	}
	// Filled in a few lines below, once the wiki service exists - the agent factory only
	// dereferences it when a run actually calls the wiki tool.
	const wikiServiceRef: { current?: LlmWikiService } = {};
	const promptManager = new PromptManager(db, logger.child("PromptManager"));
	await promptManager.initialize();
	const createAgent = buildAgentFactory(providerRef, db, workflowEngineRef, runtimeTools, wikiServiceRef, pluginManager, connectorRegistryProxy, promptManager);
	const defaultAgent = await createAgent();
	const cronjobManager = new CronjobManager(db, createAgent, logger.child("CronjobManager"), {
		runWorkflow: (workflowId: string) => workflowEngineRef.current.runWorkflow(workflowId),
		runCoding: (goal: string, options?: { verifyCommand?: string; sandboxRoot?: string }) =>
			createCodingAgentFactory({ sandboxRoot: options?.sandboxRoot }).run(goal, {
				verifyCommand: options?.verifyCommand,
			}),
	});
	cronjobManager.start();
	await ensureLogCleanupCron(db);
	await setupDefaultCronjobs(db, logger);
	const updateManager = new UpdateManager(db, logger.child("UpdateManager"));
	updateManager.start();
	const wikiService = new LlmWikiService(db, logger.child("LlmWikiService"));
	await wikiService.start();
	wikiServiceRef.current = wikiService;
	workflowExecutor.registerTool(createWikiTool(() => wikiServiceRef.current));
	const cloudBackupScheduler = new CloudBackupScheduler(db, logger.child("CloudBackupScheduler"));
	cloudBackupScheduler.start();
	const cloudHeartbeatService = new CloudHeartbeatService(db, logger.child("CloudHeartbeatService"), {
		db,
		getPlugins: () => pluginManager.getPlugins(),
		requestPluginReload: () => { pluginManager.requestReload(); },
		createAgent,
	});
	cloudHeartbeatService.start();

	app.locals["db"] = db;
	app.locals["logger"] = logger;
	app.locals["provider"] = providerRef.current;
	app.locals["workflowEngine"] = workflowEngineRef.current;
	app.locals["agent"] = defaultAgent;
	app.locals["createAgent"] = createAgent;
	app.locals["createCodingAgent"] = createCodingAgentFactory;
	app.locals["reloadProvider"] = async () => {
		const reloaded = await loadProviderFromSettings(db);
		providerRef.current = reloaded.provider;
		workflowEngineRef.current = new WorkflowEngine(providerRef.current, db, workflowExecutor, {
			logger: logger.child("WorkflowEngine"),
			codingAgentFactory: () => createCodingAgentFactory(),
		});
		app.locals["provider"] = providerRef.current;
		app.locals["workflowEngine"] = workflowEngineRef.current;
		logger.info("Provider reloaded", { provider: reloaded.providerName });
		return reloaded.providerName;
	};
	app.locals["agentRegistry"] = agentRegistry;
	app.locals["pluginManager"] = pluginManager;
	app.locals["connectorRegistryRef"] = connectorRegistryRef;
	app.locals["cronjobManager"] = cronjobManager;
	app.locals["updateManager"] = updateManager;
	app.locals["promptManager"] = promptManager;
	app.locals["wikiService"] = wikiService;
	app.locals["mcpRegistry"] = mcpRegistry;

	const io = new SocketIOServer(httpServer, {
		cors: { origin: process.env["CORS_ORIGIN"] ?? "*" },
		// Default is 1MB, which a full-page browser screenshot (fullPage:true captures the
		// ENTIRE scrollable height, not just the viewport) can exceed on a long page - as
		// base64 in a "chat:event" payload, that silently fails to send/render the preview
		// with no error surfaced anywhere. 10MB covers realistic full-page JPEG/PNG/WebP
		// screenshots with headroom.
		maxHttpBufferSize: 10 * 1024 * 1024,
	});
	// The gateway status travels in the handshake snapshot and in agent:metrics, so the
	// client no longer has to poll /agents/live for it. Generic now: one entry per connector
	// portal (still keyed "discord" for backward compat with the existing frontend type).
	setupWebSocket(io, createAgent, db, () => {
		const statuses = connectorRegistryRef.current?.getStatuses() ?? {};
		return { discord: statuses["discord"] ?? { enabled: false, configured: false, active: false, updatedAt: new Date().toISOString() }, connectors: statuses };
	});
	app.locals["io"] = io;

	// Live browser preview: the browser tool's CDP screencast frames arrive here as plain
	// events (packages/tools has no socket/io dependency of its own) - relay each one to
	// whichever clients joined that session's room (see "browser:stream:join" in
	// websocket/index.ts). One subscription for the whole process lifetime, not per-request.
	browserFrameEvents.on("frame", (frame: { sessionId: string; data: string; format: string; timestamp: string }) => {
		io.to(`browser-stream:${frame.sessionId}`).emit("browser:frame", frame);
	});

	// Initialize chat tool event broadcaster for real-time progress updates
	const toolEventBroadcaster = initChatToolEventBroadcaster(logger.child("ChatToolEvents"), io);
	app.locals["toolEventBroadcaster"] = toolEventBroadcaster;

	registerRoutes(app, db);

	// Also mounted under /api because that is the only prefix the web client's dev proxy
	// forwards - a bare /health from the browser would hit Vite and return index.html.
	const healthHandler: express.RequestHandler = (_req, res) => {
		res.json({
			status: "ok",
			version: SERVER_PROTOCOL_VERSION,
			timestamp: new Date().toISOString(),
			runningAgents: agentRegistry.snapshot().runningCount,
		});
	};
	app.get("/health", healthHandler);
	app.get("/api/health", healthHandler);

	// Serve Health Dashboard UI
	app.use(express.static("src/public", { extensions: ["html"] }));
	app.get("/dashboard", (req, res) => {
		res.sendFile(new URL("./public/health-dashboard.html", import.meta.url).pathname);
	});

	app.use(errorHandler);

	const port = Number.parseInt(process.env["PORT"] ?? "3001", 10);
	const host = process.env["HOST"] ?? "127.0.0.1";

	await listenWithRetry(httpServer, host, port);

	logger.info("Server started", {
		apiUrl: `http://${host}:${port}`,
		websocketPath: "/socket.io",
	});

	// Generic connector registry boot (Discord and any other installed connector plugin - see
	// apps/server/src/lib/connector-registry.ts and docs/gateway-connector-plugin-plan.md).
	// Inbound dispatch uses the SAME HTTP loopback the old Discord-only bootstrap used
	// (POST to /api/gateway/inbound) rather than an in-process function call - a deliberate
	// deviation from the plan's suggested direct call (see connector-registry.ts docstring and
	// the final report's "open risk decisions" section: it reuses the already-correct, non-trivial
	// /inbound processing logic - attachments, voice STT, session-reset commands, reactions -
	// without a risky rewrite, and keeps future process-isolation optionality open).
	const connectorRegistry = await ConnectorRegistry.create(async (msg) => {
		const inboundUrl = process.env["DUCKI_INBOUND_URL"]?.trim() || `http://127.0.0.1:${port}/api/gateway/inbound`;
		const payload = {
			portal: msg.portal,
			externalConversationId: msg.externalConversationId,
			sourceMessageId: msg.sourceMessageId,
			channelName: msg.channelName,
			userName: msg.userName,
			message: msg.content,
			mode: msg.attachments && msg.attachments.length > 0 && !msg.content ? "voice" : "text",
			attachments: (msg.attachments ?? []).map((a) => ({ name: a.filename, mimeType: a.mimeType, url: a.url })),
		};
		try {
			const response = await fetch(inboundUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				logger.warn("Connector inbound bridge returned non-ok", { portal: msg.portal, status: response.status, body });
			}
		} catch (error) {
			logger.warn("Connector inbound bridge failed", { portal: msg.portal, message: error instanceof Error ? error.message : String(error) });
		}
	});
	connectorRegistryRef.current = connectorRegistry;
	app.locals["connectorRegistry"] = connectorRegistry;
	logger.info("Connectors loaded", { portals: connectorRegistry.list().map((c) => c.portal) });

	const shutdown = (signal: string) => {
		logger.info("Shutting down", { signal });
		// Let clients switch to "lost" right away instead of waiting for a socket timeout.
		broadcastServerShutdown(io);
		void connectorRegistry.disconnectAll();
		cronjobManager.stop();
		updateManager.stop();
		wikiService.stop();
		toolStagingManager.stop();
		void mcpRegistry.shutdown();
		io.close();
		httpServer.close(() => {
			process.exit(0);
		});
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

bootstrap().catch((error) => {
	logger.error("Failed to start server", {
		error: error instanceof Error ? error.message : String(error),
	});
	process.exit(1);
});