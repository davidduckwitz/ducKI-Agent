import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { Server as SocketIOServer } from "socket.io";
import {
	Agent,
	WorkflowEngine,
	createWorkflowManagementTool,
	createCronjobManagementTool,
	Executor,
	createDynamicToolResolver,
	createToolFactoryTool,
	createCodingAgent,
	type CodingAgent,
} from "@ducki/agent";
import { getDatabase } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { MCPRegistry, type MCPServerConfig } from "@ducki/mcp";
import type { ToolExecutor } from "@ducki/shared";
import { createProvider, type ProviderName } from "@ducki/providers";
import { allTools } from "@ducki/tools";
import { errorHandler } from "./middleware/error-handler.js";
import { DiscordGatewayClient } from "./lib/discord-gateway-ws.js";
import { agentRegistry } from "./lib/agent-registry.js";
import { CronjobManager } from "./lib/cronjob-manager.js";
import { createMcpTool } from "./lib/mcp-tool.js";
import { UpdateManager } from "./lib/update-manager.js";
import { LlmWikiService } from "./lib/llm-wiki-service.js";
import { agentsRouter } from "./routes/agents.js";
import { chatRouter } from "./routes/chat.js";
import { cronjobsRouter } from "./routes/cronjobs.js";
import { codingRouter, CODING_ROOT } from "./routes/coding.js";
import { codingAgentRouter } from "./routes/coding-agent.js";
import { gatewayRouter } from "./routes/gateway.js";
import { logsRouter } from "./routes/logs.js";
import { mcpRouter } from "./routes/mcp.js";
import { memoryRouter } from "./routes/memory.js";
import { projectsRouter } from "./routes/projects.js";
import { settingsRouter } from "./routes/settings.js";
import { sharedRouter } from "./routes/shared.js";
import { skillsRouter } from "./routes/skills.js";
import { tasksRouter } from "./routes/tasks.js";
import { toolsRouter } from "./routes/tools.js";
import { updatesRouter } from "./routes/updates.js";
import { workflowsRouter } from "./routes/workflows.js";
import { wikiRouter } from "./routes/wiki.js";
import { setupWebSocket } from "./websocket/index.js";

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

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined) return defaultValue;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return defaultValue;
}

interface MessagingGatewayBootstrapConfig {
	id: string;
	portal: "discord" | "telegram" | "slack" | "signal" | "custom";
	enabled: boolean;
	guildId?: string;
	userId?: string;
	authToken?: string;
}

interface DiscordGatewayRuntimeStatus {
	enabled: boolean;
	configured: boolean;
	active: boolean;
	connectedAt?: string;
	lastError?: string;
	updatedAt: string;
}

function normalizePortal(value: string): MessagingGatewayBootstrapConfig["portal"] {
	const normalized = value.trim().toLowerCase();
	if (normalized === "discord" || normalized === "telegram" || normalized === "slack" || normalized === "signal") {
		return normalized;
	}
	return "custom";
}

function parseGatewayConfigs(raw: string | undefined): MessagingGatewayBootstrapConfig[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((item) => item && typeof item === "object")
			.map((item) => item as Record<string, unknown>)
			.map((item, index) => ({
				id: String(item["id"] ?? `gateway_${index + 1}`),
				portal: normalizePortal(String(item["portal"] ?? "custom")),
				enabled: Boolean(item["enabled"] ?? true),
				guildId: item["guildId"] ? String(item["guildId"]) : undefined,
				userId: item["userId"] ? String(item["userId"]) : undefined,
				authToken: item["authToken"] ? String(item["authToken"]) : undefined,
			}));
	} catch {
		return [];
	}
}

async function resolveDiscordBridgeConfig(db: Awaited<ReturnType<typeof getDatabase>>): Promise<{
	botToken?: string;
	guildId?: string;
	allowedUserId?: string;
	configId?: string;
}> {
	const envBotToken = process.env["DISCORD_BOT_TOKEN"]?.trim();
	const envGuildId = process.env["DISCORD_GUILD_ID"]?.trim();
	const envAllowedUserId = process.env["DISCORD_ALLOWED_USER_ID"]?.trim();
	if (envBotToken) {
		return {
			botToken: envBotToken,
			guildId: envGuildId,
			allowedUserId: envAllowedUserId,
		};
	}

	const raw = await db.getSetting("MESSAGING_GATEWAYS");
	const configs = parseGatewayConfigs(raw);
	const discordConfig = configs.find((entry) => entry.enabled && entry.portal === "discord" && entry.authToken?.trim());
	if (!discordConfig) {
		return {
			guildId: envGuildId,
			allowedUserId: envAllowedUserId,
		};
	}

	return {
		botToken: discordConfig.authToken?.trim(),
		guildId: envGuildId ?? discordConfig.guildId?.trim(),
		allowedUserId: envAllowedUserId ?? discordConfig.userId?.trim(),
		configId: discordConfig.id,
	};
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
	if (normalized === "openai" || normalized === "openrouter" || normalized === "ollama" || normalized === "lmstudio") {
		return normalized;
	}
	return "lmstudio";
}

async function loadProviderFromSettings(db: Awaited<ReturnType<typeof getDatabase>>) {
	const allSettings = await db.getAllSettings();
	const settingMap = new Map(allSettings.map((entry) => [entry.key, entry.value]));
	const providerName = parseProviderName(
		readSettingValue(settingMap, "DEFAULT_PROVIDER", "DEFAULT_PROVIDER", "lmstudio")
	);

	if (providerName === "lmstudio") {
		const provider = createProvider({
			name: "lmstudio",
			baseUrl: readSettingValue(settingMap, "LM_STUDIO_BASE_URL", "LM_STUDIO_BASE_URL", "http://localhost:1234/v1"),
			model: readSettingValue(settingMap, "LM_STUDIO_MODEL", "LM_STUDIO_MODEL", "local-model"),
			apiKey: normalizeApiKey(readSettingValue(settingMap, "LM_STUDIO_API_KEY", "LM_STUDIO_API_KEY")),
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

function buildAgentFactory(
	providerRef: { current: ReturnType<typeof createProvider> },
	db: Awaited<ReturnType<typeof getDatabase>>,
	workflowEngineRef: { current: WorkflowEngine },
	runtimeTools: ToolExecutor[]
) {
	return () => {
		const agent = new Agent(providerRef.current, db);
		for (const tool of runtimeTools) {
			agent.executor.registerTool(tool);
		}
		agent.executor.registerTool(createWorkflowManagementTool(workflowEngineRef.current));
		agent.executor.registerTool(createCronjobManagementTool(db));
		agent.executor.registerTool(createToolFactoryTool(db, agent.executor));
		return agent;
	};
}

function registerRoutes(app: express.Express): void {
	app.use("/api/chat", chatRouter);
	app.use("/api/tasks", tasksRouter);
	app.use("/api/projects", projectsRouter);
	app.use("/api/tools", toolsRouter);
	app.use("/api/memory", memoryRouter);
	app.use("/api/settings", settingsRouter);
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
	app.use("/api/wiki", wikiRouter);
}

async function bootstrapDiscordGatewayBridge(
  port: number,
	db: Awaited<ReturnType<typeof getDatabase>>,
	status: DiscordGatewayRuntimeStatus
): Promise<DiscordGatewayClient | undefined> {
	const enabled = parseBoolean(process.env["DISCORD_GATEWAY_ENABLED"], true);
	status.enabled = enabled;
	status.updatedAt = new Date().toISOString();
	if (!enabled) {
		status.configured = false;
		status.active = false;
		status.lastError = "DISCORD_GATEWAY_ENABLED=false";
		status.updatedAt = new Date().toISOString();
		logger.info("Discord Gateway disabled by DISCORD_GATEWAY_ENABLED");
		return undefined;
	}

	const resolved = await resolveDiscordBridgeConfig(db);
	const botToken = resolved.botToken;
	if (!botToken) {
		status.configured = false;
		status.active = false;
		status.lastError = "Missing Discord bot token";
		status.updatedAt = new Date().toISOString();
		logger.warn("Discord Gateway not started: no bot token configured (env DISCORD_BOT_TOKEN or gateway authToken)");
		return undefined;
	}

	status.configured = true;
	status.active = false;
	status.lastError = undefined;
	status.updatedAt = new Date().toISOString();

	const guildId = resolved.guildId;
	const allowedUserId = resolved.allowedUserId;
	const inboundUrl = process.env["DISCORD_INBOUND_URL"]?.trim() || `http://127.0.0.1:${port}/api/gateway/inbound`;

	const client = new DiscordGatewayClient({
		botToken,
		guildId,
		allowedUserId,
		onReady: (botUserId) => {
			status.active = true;
			status.connectedAt = new Date().toISOString();
			status.lastError = undefined;
			status.updatedAt = new Date().toISOString();
			logger.info("Discord Gateway connected", { botUserId, guildId, allowedUserId, inboundUrl, configId: resolved.configId });
		},
		onError: (err) => {
			status.active = false;
			status.lastError = err.message;
			status.updatedAt = new Date().toISOString();
			logger.warn("Discord Gateway error", { message: err.message });
		},
		onMessage: async (msg) => {
			const payload = {
				portal: "discord",
				externalConversationId: msg.channelId,
				sourceMessageId: msg.messageId,
				channelName: msg.channelName,
				userName: msg.authorName,
				message: msg.content,
				mode: msg.attachments.length > 0 && !msg.content ? "voice" : "text",
				attachments: msg.attachments.map((attachment) => ({
					name: attachment.filename,
					mimeType: attachment.contentType,
					url: attachment.url,
				})),
			};

			try {
				const response = await fetch(inboundUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				});
				if (!response.ok) {
					const body = await response.text().catch(() => "");
					logger.warn("Discord inbound bridge returned non-ok", {
						status: response.status,
						statusText: response.statusText,
						body,
					});
				}
			} catch (error) {
				logger.warn("Discord inbound bridge failed", {
					message: error instanceof Error ? error.message : String(error),
				});
			}
		},
	});

	client.start();
	return client;
}

async function bootstrap(): Promise<void> {
	const app = express();
	const httpServer = createServer(app);

	app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
	app.use(
		cors({
			origin: process.env["CORS_ORIGIN"] ?? "*",
			methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
			credentials: true,
		})
	);

	app.use(
		express.json({
			limit: "10mb",
			verify: (req, _res, buf) => {
				(req as RequestWithRawBody).rawBody = Buffer.from(buf).toString("utf8");
			},
		})
	);
	app.use(express.urlencoded({ extended: true }));

	const db = await getDatabase();
	const discordGatewayStatus: DiscordGatewayRuntimeStatus = {
		enabled: parseBoolean(process.env["DISCORD_GATEWAY_ENABLED"], true),
		configured: false,
		active: false,
		updatedAt: new Date().toISOString(),
	};
	const loadedProvider = await loadProviderFromSettings(db);
	const provider = loadedProvider.provider;
	logger.info("Provider loaded", { provider: loadedProvider.providerName });
	const mcpRegistry = new MCPRegistry();
	const mcpServers = parseMcpServerConfigs(await db.getSetting(MCP_SERVERS_SETTING));
	await mcpRegistry.syncServers(mcpServers);
	const runtimeTools: ToolExecutor[] = [...allTools, createMcpTool(mcpRegistry)];
	const providerRef: { current: ReturnType<typeof createProvider> } = { current: provider };

	// Persistent Executor dedicated to the WorkflowEngine (tool_call nodes dispatch
	// through it directly), wired with the same DB-backed dynamic tool resolver used
	// by every per-request Agent so dynamically registered tools resolve everywhere.
	const workflowExecutor = new Executor(logger.child("WorkflowExecutor"), createDynamicToolResolver(db));
	for (const tool of runtimeTools) {
		workflowExecutor.registerTool(tool);
	}
	workflowExecutor.registerTool(createCronjobManagementTool(db));
	workflowExecutor.registerTool(createToolFactoryTool(db, workflowExecutor));

	const createCodingAgentFactory = (options?: { sandboxRoot?: string }): CodingAgent =>
		createCodingAgent(providerRef.current, db, { sandboxRoot: options?.sandboxRoot ?? CODING_ROOT });

	const workflowEngineRef: { current: WorkflowEngine } = {
		current: new WorkflowEngine(providerRef.current, db, workflowExecutor, {
			logger: logger.child("WorkflowEngine"),
			codingAgentFactory: () => createCodingAgentFactory(),
		}),
	};
	workflowExecutor.registerTool(createWorkflowManagementTool(workflowEngineRef.current));
	const createAgent = buildAgentFactory(providerRef, db, workflowEngineRef, runtimeTools);
	const defaultAgent = createAgent();
	const cronjobManager = new CronjobManager(db, createAgent, logger.child("CronjobManager"));
	cronjobManager.start();
	const updateManager = new UpdateManager(db, logger.child("UpdateManager"));
	updateManager.start();
	const wikiService = new LlmWikiService(db, logger.child("LlmWikiService"));
	await wikiService.start();

	app.locals["db"] = db;
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
	app.locals["discordGatewayStatus"] = discordGatewayStatus;
	app.locals["cronjobManager"] = cronjobManager;
	app.locals["updateManager"] = updateManager;
	app.locals["wikiService"] = wikiService;
	app.locals["mcpRegistry"] = mcpRegistry;

	const io = new SocketIOServer(httpServer, {
		cors: { origin: process.env["CORS_ORIGIN"] ?? "*" },
	});
	setupWebSocket(io, createAgent, db);
	app.locals["io"] = io;

	registerRoutes(app);

	app.get("/health", (_req, res) => {
		res.json({
			status: "ok",
			timestamp: new Date().toISOString(),
			runningAgents: agentRegistry.snapshot().runningCount,
		});
	});

	app.use(errorHandler);

	const port = Number.parseInt(process.env["PORT"] ?? "3001", 10);
	const host = process.env["HOST"] ?? "127.0.0.1";

	await listenWithRetry(httpServer, host, port);

	logger.info("Server started", {
		apiUrl: `http://${host}:${port}`,
		websocketPath: "/socket.io",
	});

	const discordGateway = await bootstrapDiscordGatewayBridge(port, db, discordGatewayStatus);

	const shutdown = (signal: string) => {
		logger.info("Shutting down", { signal });
		discordGatewayStatus.active = false;
		discordGatewayStatus.updatedAt = new Date().toISOString();
		discordGateway?.stop();
		cronjobManager.stop();
		updateManager.stop();
		wikiService.stop();
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