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
	DEFAULT_SYSTEM_PROMPT,
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
import { allTools, browserActivityEvents, browserFrameEvents, stopAllBackgroundProcesses } from "@ducki/tools";
import { errorHandler } from "./middleware/error-handler.js";
import { loadProviderFromSettings } from "./lib/provider-settings.js";
import { ConnectorRegistry } from "./lib/connector-registry.js";
import { agentRegistry } from "./lib/agent-registry.js";
import { CronjobManager } from "./lib/cronjob-manager.js";
import { createMcpTool } from "./lib/mcp-tool.js";
import { UpdateManager } from "./lib/update-manager.js";
import { setupDefaultCronjobs } from "./lib/default-cronjobs.js";
import { LlmWikiService } from "./lib/llm-wiki-service.js";
import { CloudBackupScheduler } from "./lib/cloud-backup-scheduler.js";
import { CloudHeartbeatService } from "./lib/cloud-heartbeat.js";
import { CloudVoiceChatService } from "./lib/cloud-voice.js";
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
import { withBrowserArtifactRecording, withFilesystemArtifactRecording } from "./lib/artifact-recording.js";
import { createPushNotificationTool } from "./lib/push-notification-tool.js";
import { createBuilderManagementTool } from "./lib/builder-management-tool.js";
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
import { artifactsRouter } from "./routes/artifacts.js";
import { toolsRouter } from "./routes/tools.js";
import { updatesRouter } from "./routes/updates.js";
import { workflowsRouter } from "./routes/workflows.js";
import { wikiRouter } from "./routes/wiki.js";
import { createCryptoPaymentRouter } from "./routes/crypto-payment.js";
import { createToolStagingRouter } from "./routes/tool-staging.js";
import { screenshotRouter } from "./routes/screenshots.js";
import { createProviderModelsRouter } from "./routes/provider-models.js";
import { botsRouter } from "./routes/bots.js";
import { botChatsRouter } from "./routes/bot-chats.js";
import { pendingWritesRouter } from "./routes/pending-writes.js";
import { projectSkillsRouter } from "./routes/project-skills.js";
import { BackgroundReviewFork } from "./lib/background-review.js";
import { projectSkills } from "./lib/project-skills-service.js";
import { createSessionSearchTool } from "./lib/session-search-tool.js";
import { BotService } from "./lib/bot-service.js";
import { createDelegateToBotTool } from "./lib/delegate-to-bot-tool.js";
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
	promptManager: PromptManager,
	botServiceRef: { current?: BotService }
) {
	return async (override: { model?: string } = {}) => {
		// Load database settings for agent configuration
		const maxIterationsSetting = await db.getSetting("AGENT_MAX_ITERATIONS");
		logger.debug("buildAgentFactory: loading agent settings", {
			maxIterationsSetting,
			parsed: maxIterationsSetting ? parseInt(maxIterationsSetting) : undefined,
		});
		// The Memory settings UI lets a user edit system.md/agent.md/human.md via PromptManager -
		// without reading all three back here, agent persona (character) and human-info edits were
		// dead letters: saved to the DB/file but never reaching any Agent instance's system prompt.
		const [customSystemPrompt, agentBehavior, humanInfo] = await Promise.all([
			promptManager.getPrompt("system"),
			promptManager.getPrompt("agent"),
			promptManager.getPrompt("human"),
		]);
		const profileSections =
			(agentBehavior.trim() ? `\n\n## Agent Persona\n${agentBehavior.trim()}` : "") +
			(humanInfo.trim() ? `\n\n## About the User\n${humanInfo.trim()}` : "");
		const combinedSystemPrompt = (customSystemPrompt.trim() || DEFAULT_SYSTEM_PROMPT) + profileSections;
		// Discover project-local skills from the current working directory's git repo.
		// Project skills win over same-slug built-in skills (project > local > external).
		const projectSkillManifests = projectSkills.discoverProjectSkills();

		const agentOptions = {
			...(maxIterationsSetting ? { maxIterations: parseInt(maxIterationsSetting) } : {}),
			...(customSystemPrompt.trim() || profileSections ? { systemPrompt: combinedSystemPrompt } : {}),
			...(projectSkillManifests.length > 0 ? { projectSkillManifests } : {}),
		};

		// Voice-Chat can select a model for one conversation turn without mutating the
		// globally configured provider/model used by the regular WebUI and background jobs.
		const requestProvider = override.model?.trim()
			? (await loadProviderFromSettings(db, { model: override.model })).provider
			: providerRef.current;
		const agent = new Agent(requestProvider, db, undefined, agentOptions);
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
		// Only the main agent gets this tool - a bot's own Agent instance (BotService.
		// createAgentForBot) is never given it, so a bot cannot delegate again (no recursion guard
		// needed). See lib/delegate-to-bot-tool.ts.
		agent.executor.registerTool(createDelegateToBotTool(() => botServiceRef.current));
		// Builder mutations belong only to the primary conversational agent. Bots and workflow
		// executors do not receive this tool, preventing recursive or unattended creation chains.
		agent.executor.registerTool(createBuilderManagementTool(db));
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
	app.use("/api/artifacts", artifactsRouter);
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
	// Bitcoin puzzle solver moved to apps/server/plugins/bitcoin-puzzle (own moduleTool +
	// frontend page at /api/plugins/bitcoin-puzzle/*) - the old route is decommissioned, not
	// deleted, so packages/agent/src/crypto and apps/server/src/routes/bitcoin-puzzle.ts stay
	// available for reference/revert.
	setupCredentialRoutes(database);
	app.use("/api/credentials", credentialRouter);
	app.use("/api/logs", logsRouter);
	app.use("/api/agents", agentsRouter);
	app.use("/api/bots", botsRouter);
	app.use("/api/bot-chats", botChatsRouter);
	app.use("/api/pending-writes", pendingWritesRouter);
	app.use("/api/project-skills", projectSkillsRouter);
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

	const mcpRegistry = new MCPRegistry();
	const mcpServers = parseMcpServerConfigs(await db.getSetting(MCP_SERVERS_SETTING));
	await mcpRegistry.syncServers(mcpServers);
	// File-first plugins (plugins/<name>/): the PluginManager owns the current tool set and
	// hot-reloads it on enable/disable/install WITHOUT interrupting running agents (it defers
	// the swap until no agent is active). Per-request agents register these via the factory.
	const pluginManager = await PluginManager.create(db);
	logger.info("Plugins loaded at startup", {
		enabled: pluginManager.getPlugins().filter((p) => p.enabled && !p.error).length,
		tools: pluginManager.getTools().length,
	});
	// Plugin providers must be registered before resolving DEFAULT_PROVIDER, otherwise a
	// provider contributed by an enabled plugin would look unknown during startup.
	const loadedProvider = await loadProviderFromSettings(db);
	const provider = loadedProvider.provider;
	logger.info("Provider loaded", { provider: loadedProvider.providerName });
	const runtimeTools: ToolExecutor[] = [
		...allTools,
		createMcpTool(mcpRegistry),
		createCryptoPaymentMcpTool(db),
		createSessionSearchTool(db),
		// Browser automation is handled by the real `browser` tool (in allTools, Puppeteer in an
		// isolated worker) plus the browser-control SKILL. A former `browser-control` MCP stub was
		// removed: it returned a 1x1 mock screenshot yet reported success, so the model picked it
		// over the real tool and "browsed" nothing.
		createTasksMcpTool(db),
		createWorkflowMcpTool(db),
		createCronjobsMcpTool(db),
		createPushNotificationTool(db),
	].map((tool) => {
		// Screenshots/PDFs the agent captures and documents it writes join the artifact
		// registry alongside chat uploads and video previews - see artifact-recording.ts.
		// This is the SHARED_WORKSPACE_ROOT-scoped `filesystem` tool from allTools, not the
		// CodingAgent's separate project-scoped instance, so coding writes are excluded by
		// construction (that instance is never part of runtimeTools).
		if (tool.name === "browser") return withBrowserArtifactRecording(tool, db, logger.child("ArtifactRecording"));
		if (tool.name === "filesystem") return withFilesystemArtifactRecording(tool, db, logger.child("ArtifactRecording"));
		return tool;
	});
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

	// Optional cheap model for the coding agent's read-only exploration sub-agent. Built once:
	// a run can call explore several times, and re-creating a provider per call would re-read
	// credentials and re-open a client for no benefit. Unset means "use the main model", which
	// is exactly the previous behaviour.
	const explorerProvider = (() => {
		const model = (process.env["DUCKI_EXPLORE_MODEL"] ?? "").trim();
		if (!model) return undefined;
		const name = (process.env["DUCKI_EXPLORE_PROVIDER"] ?? process.env["LLM_PROVIDER"] ?? "openrouter").trim() as ProviderName;
		try {
			const created = createProvider({ name, model });
			logger.info("Explorer provider configured", { provider: name, model });
			return created;
		} catch (error) {
			logger.warn("Could not create explorer provider, falling back to the main model", {
				model,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	})();

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
			...(explorerProvider ? { explorerProvider } : {}),
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
	// Same lazy-ref pattern as wikiServiceRef: BotService is constructed after buildAgentFactory
	// (it needs createAgent/createCodingAgentFactory), but the delegate_to_bot tool it wires only
	// dereferences this when a run actually calls the tool.
	const botServiceRef: { current?: BotService } = {};
	const promptManager = new PromptManager(db, logger.child("PromptManager"));
	await promptManager.initialize();
	const createAgent = buildAgentFactory(providerRef, db, workflowEngineRef, runtimeTools, wikiServiceRef, pluginManager, connectorRegistryProxy, promptManager, botServiceRef);
	const defaultAgent = await createAgent();
	const botService = new BotService({
		db,
		providerRef,
		runtimeTools,
		pluginManager,
		createAgent,
		createCodingAgentFactory,
	});
	await botService.ensureBuiltinBots();
	botServiceRef.current = botService;

	// Background Review Fork: fire-and-forget post-turn learning analysis.
	// Runs on a cheap model, proposes memory/skill updates through the write-approval gate.
	const bgReview = new BackgroundReviewFork(db, providerRef.current);

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
		logger: logger.child("CloudControl"),
		getPlugins: () => pluginManager.getPlugins(),
		requestPluginReload: () => { pluginManager.requestReload(); },
		createAgent,
		runMainBot: async (message: string) => {
			const mainBot = await botService.getBot("main");
			if (!mainBot) throw new Error("Main-Bot wurde nicht gefunden");
			return botService.chat(mainBot, message);
		},
		listBots: async () => botService.listBots() as unknown as Array<Record<string, unknown>>,
	});
	cloudHeartbeatService.start();
	const cloudVoiceChatService = new CloudVoiceChatService(db, logger.child("CloudVoiceChatService"), {
		db,
		logger: logger.child("CloudControl"),
		getPlugins: () => pluginManager.getPlugins(),
		requestPluginReload: () => { pluginManager.requestReload(); },
		createAgent,
		runMainBot: async (message: string) => {
			const mainBot = await botService.getBot("main");
			if (!mainBot) throw new Error("Main-Bot wurde nicht gefunden");
			return botService.chat(mainBot, message);
		},
		listBots: async () => botService.listBots() as unknown as Array<Record<string, unknown>>,
	});
	cloudVoiceChatService.start();

	app.locals["db"] = db;
	app.locals["logger"] = logger;
	app.locals["provider"] = providerRef.current;
	app.locals["workflowEngine"] = workflowEngineRef.current;
	app.locals["agent"] = defaultAgent;
	app.locals["createAgent"] = createAgent;
	app.locals["createCodingAgent"] = createCodingAgentFactory;
	app.locals["botService"] = botService;
	app.locals["bgReview"] = bgReview;
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
	browserFrameEvents.on("frame", (frame: { sessionId: string; data: string; format: string; timestamp: string; width?: number; height?: number }) => {
		io.to(`browser-stream:${frame.sessionId}`).emit("browser:frame", frame);
	});
	browserActivityEvents.on("activity", (activity: unknown) => {
		io.emit("browser:activity", activity);
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
		// Background processes the shell tool started (a dev server the agent launched) are
		// children of this process but do not die with it - without this they keep running and
		// keep holding their port after a restart.
		stopAllBackgroundProcesses();
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
