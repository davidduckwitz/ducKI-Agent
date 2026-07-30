/**
 * Browser-based Agent SDK Runtime
 * Runs the agent in the browser with IndexedDB persistence and fetch-based tool calls.
 * Enables collaborative coding UX in web applications.
 */

import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage } from "@ducki/shared";
import type { AgentRunOptions } from "../config/interfaces_types.js";
import type { SDKTool, SDKToolRegistry, AgentIteration } from "../core/agent-sdk-interfaces.js";
import { AgentRunnerV2 } from "../agent-runner-v2.js";

/**
 * Browser runtime configuration.
 */
export interface BrowserRuntimeConfig {
  /** IndexedDB database name for persisting conversations */
  dbName?: string;
  /** Max conversation history to keep in memory (older messages are archived) */
  maxHistorySize?: number;
  /** URL to backend tool execution endpoint */
  toolEndpoint?: string;
  /** Optional event broadcaster (for multi-tab sync) */
  broadcastChannel?: BroadcastChannel;
}

/**
 * Browser-specific tool that proxies execution to backend.
 */
class RemoteToolProxy implements SDKTool {
  constructor(
    readonly name: string,
    readonly description: string,
    private endpoint: string
  ) {}

  async execute(input: Record<string, unknown>) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: this.name, input }),
    });

    if (!response.ok) {
      return {
        success: false,
        data: null,
        error: `Tool execution failed: ${response.statusText}`,
      };
    }

    return response.json();
  }
}

/**
 * Browser-optimized tool registry using fetch proxies.
 */
class BrowserToolRegistry implements SDKToolRegistry {
  private tools = new Map<string, SDKTool>();

  constructor(
    private endpoint: string,
    private availableToolsList: Array<{ name: string; description: string }>
  ) {
    // Create remote proxy for each available tool
    for (const toolInfo of availableToolsList) {
      this.tools.set(toolInfo.name, new RemoteToolProxy(toolInfo.name, toolInfo.description, endpoint));
    }
  }

  getTool(name: string): SDKTool | undefined {
    return this.tools.get(name);
  }

  listTools(): SDKTool[] {
    return Array.from(this.tools.values());
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }
}

/**
 * IndexedDB-backed conversation persistence for browser.
 */
class BrowserConversationStore {
  private db: IDBDatabase | null = null;
  private readonly storeName = "conversations";

  async init(dbName: string = "ducki-agent"): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "id" });
        }
      };
    });
  }

  async save(conversationId: string, messages: LLMMessage[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) reject(new Error("DB not initialized"));

      const tx = this.db!.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      store.put({ id: conversationId, messages, savedAt: Date.now() });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async load(conversationId: string): Promise<LLMMessage[] | null> {
    return new Promise((resolve, reject) => {
      if (!this.db) reject(new Error("DB not initialized"));

      const tx = this.db!.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.get(conversationId);

      request.onsuccess = () => resolve(request.result?.messages ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async list(): Promise<Array<{ id: string; savedAt: number }>> {
    return new Promise((resolve, reject) => {
      if (!this.db) reject(new Error("DB not initialized"));

      const tx = this.db!.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.getAll();

      request.onsuccess = () =>
        resolve(
          request.result.map((r: any) => ({
            id: r.id,
            savedAt: r.savedAt,
          }))
        );
      request.onerror = () => reject(request.error);
    });
  }
}

/**
 * Browser-based Agent Runtime.
 * Provides conversation persistence and remote tool execution for web UIs.
 */
export class BrowserAgentRuntime {
  private runner: AgentRunnerV2;
  private store: BrowserConversationStore;
  private toolRegistry: BrowserToolRegistry;
  private config: Required<BrowserRuntimeConfig>;

  constructor(
    private provider: LLMProvider,
    availableTools: Array<{ name: string; description: string }>,
    config: BrowserRuntimeConfig = {}
  ) {
    this.config = {
      dbName: config.dbName ?? "ducki-agent",
      maxHistorySize: config.maxHistorySize ?? 500,
      toolEndpoint: config.toolEndpoint ?? "/api/tools/execute",
      broadcastChannel: config.broadcastChannel || (undefined as any),
    } as Required<BrowserRuntimeConfig>;

    this.store = new BrowserConversationStore();
    this.toolRegistry = new BrowserToolRegistry(this.config.toolEndpoint, availableTools);
    this.runner = new AgentRunnerV2(provider, null as any); // DB not used in browser
  }

  /**
   * Initialize the runtime (async setup).
   */
  async initialize(): Promise<void> {
    await this.store.init(this.config.dbName);
  }

  /**
   * Run agent and stream frames.
   */
  async *run(userInput: string, conversationId: string, options: AgentRunOptions = {}) {
    // Load existing conversation
    const existing = await this.store.load(conversationId);
    if (existing) {
      (this.runner.getAgent() as any).conversation.messages = existing;
    }

    // Run with streaming
    yield* this.runner.run(userInput, options);

    // Save conversation after run
    const messages = (this.runner.getAgent() as any).conversation.messages;
    await this.store.save(conversationId, messages);

    // Broadcast to other tabs if channel available
    if (this.config.broadcastChannel) {
      this.config.broadcastChannel.postMessage({
        type: "conversation_updated",
        conversationId,
        messageCount: messages.length,
      });
    }
  }

  /**
   * List saved conversations.
   */
  async listConversations() {
    return this.store.list();
  }

  /**
   * Delete a conversation.
   */
  async deleteConversation(conversationId: string): Promise<void> {
    // Implementation: delete from IndexedDB
  }
}

/**
 * Factory function for creating browser runtime.
 */
export function createBrowserAgentRuntime(
  provider: LLMProvider,
  availableTools: Array<{ name: string; description: string }>,
  config?: BrowserRuntimeConfig
): BrowserAgentRuntime {
  return new BrowserAgentRuntime(provider, availableTools, config);
}
