import { getRootLogger } from "@ducki/logger";
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export class MCPClient {
    serverId;
    serverUrl;
    options;
    tools = new Map();
    logger;
    connected = false;
    stopping = false;
    reconnecting = false;
    reconnectAttempts = 0;
    refreshTimer = null;
    constructor(serverId, serverUrl, options = {}) {
        this.serverId = serverId;
        this.serverUrl = serverUrl;
        this.options = options;
        this.logger = getRootLogger().child(`MCPClient:${serverId}`);
    }
    get reconnectBaseMs() {
        return Math.max(250, Number(this.options.reconnectBaseMs ?? 750));
    }
    get reconnectMaxMs() {
        return Math.max(this.reconnectBaseMs, Number(this.options.reconnectMaxMs ?? 15000));
    }
    get toolsRefreshMs() {
        return Math.max(1000, Number(this.options.toolsRefreshMs ?? 15000));
    }
    async fetchTools() {
        const response = await fetch(`${this.serverUrl}/tools`);
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        const data = (await response.json());
        return Array.isArray(data.tools) ? data.tools : [];
    }
    applyTools(tools) {
        this.tools.clear();
        for (const tool of tools) {
            this.tools.set(tool.name, { ...tool, serverId: this.serverId });
        }
    }
    scheduleRefresh() {
        if (this.refreshTimer)
            clearInterval(this.refreshTimer);
        this.refreshTimer = setInterval(async () => {
            if (this.stopping)
                return;
            try {
                const tools = await this.fetchTools();
                this.applyTools(tools);
                if (!this.connected) {
                    this.connected = true;
                    this.reconnectAttempts = 0;
                }
            }
            catch (error) {
                this.connected = false;
                this.logger.warn("MCP tools refresh failed", {
                    url: this.serverUrl,
                    error: error instanceof Error ? error.message : String(error),
                });
                void this.ensureReconnect();
            }
        }, this.toolsRefreshMs);
    }
    async ensureReconnect() {
        if (this.reconnecting || this.stopping || this.connected)
            return;
        this.reconnecting = true;
        try {
            while (!this.stopping && !this.connected) {
                this.reconnectAttempts += 1;
                const delay = Math.min(this.reconnectBaseMs * 2 ** (this.reconnectAttempts - 1), this.reconnectMaxMs);
                await sleep(delay);
                if (this.stopping)
                    break;
                try {
                    const tools = await this.fetchTools();
                    this.applyTools(tools);
                    this.connected = true;
                    this.reconnectAttempts = 0;
                    this.logger.info("MCP reconnected", { url: this.serverUrl, tools: this.tools.size });
                }
                catch (error) {
                    this.connected = false;
                    this.logger.warn("MCP reconnect attempt failed", {
                        url: this.serverUrl,
                        attempt: this.reconnectAttempts,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }
        finally {
            this.reconnecting = false;
        }
    }
    async connect() {
        this.stopping = false;
        try {
            const tools = await this.fetchTools();
            this.applyTools(tools);
            this.connected = true;
            this.reconnectAttempts = 0;
            this.logger.info("MCP connected", { url: this.serverUrl, tools: this.tools.size });
        }
        catch (error) {
            this.connected = false;
            this.logger.warn("MCP initial connect failed", {
                url: this.serverUrl,
                error: error instanceof Error ? error.message : String(error),
            });
            void this.ensureReconnect();
        }
        this.scheduleRefresh();
    }
    async disconnect() {
        this.stopping = true;
        this.connected = false;
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
    isConnected() {
        return this.connected;
    }
    getReconnectAttempts() {
        return this.reconnectAttempts;
    }
    async callTool(name, input) {
        try {
            const response = await fetch(`${this.serverUrl}/tools/${name}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(input),
            });
            if (!response.ok) {
                return { success: false, data: null, error: `HTTP ${response.status}` };
            }
            const result = (await response.json());
            return result;
        }
        catch (error) {
            this.connected = false;
            void this.ensureReconnect();
            return {
                success: false,
                data: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    async *streamTool(name, input) {
        const response = await fetch(`${this.serverUrl}/tools/${name}/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
            body: JSON.stringify(input),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        if (!response.body) {
            throw new Error("MCP stream response has no body");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";
            for (const part of parts) {
                const lines = part
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean);
                for (const line of lines) {
                    if (!line.startsWith("data:"))
                        continue;
                    yield line.slice(5).trim();
                }
            }
        }
    }
    getToolDefinitions() {
        return Array.from(this.tools.values()).map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        }));
    }
    listTools() {
        return Array.from(this.tools.values());
    }
}
//# sourceMappingURL=client.js.map