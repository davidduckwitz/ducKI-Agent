import type { ToolDefinition, ToolResult, ToolExecutor } from "@ducki/shared";
import type { Logger } from "@ducki/logger";

export interface ToolCallWithId {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type DynamicToolResolver = (name: string) => Promise<ToolExecutor | undefined>;

export class Executor {
  private tools = new Map<string, ToolExecutor>();
  private browserSessions = new Map<string, unknown>();
  private lastBrowserSessionId: string | undefined; // Track latest browser session ID

  constructor(
    private readonly logger: Logger,
    private readonly dynamicResolver?: DynamicToolResolver
  ) {}

  registerTool(tool: ToolExecutor): void {
    this.tools.set(tool.name, tool);
    this.logger.debug("Tool registered", { name: tool.name });
  }

  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  registerBrowserSession(sessionId: string, session: unknown): void {
    this.browserSessions.set(sessionId, session);
    this.logger.debug("Browser session registered", { sessionId });
  }

  getBrowserSession(sessionId: string): unknown | undefined {
    return this.browserSessions.get(sessionId);
  }

  deleteBrowserSession(sessionId: string): boolean {
    return this.browserSessions.delete(sessionId);
  }

  /**
   * Checks whether a tool is available, including dynamically-registered tools
   * that live in the database rather than the in-memory map (an Executor is
   * recreated on every request, so this fallback is what lets a tool created by
   * an earlier run still resolve here).
   */
  async hasTool(name: string): Promise<boolean> {
    if (this.tools.has(name)) return true;
    if (!this.dynamicResolver) return false;
    return Boolean(await this.dynamicResolver(name));
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<ToolResult> {
    let tool = this.tools.get(toolName);
    if (!tool && this.dynamicResolver) {
      tool = await this.dynamicResolver(toolName);
    }
    if (!tool) {
      return {
        success: false,
        data: null,
        error: `Tool '${toolName}' not found. Available tools: ${Array.from(this.tools.keys()).join(", ")}`,
      };
    }

    // Check if already aborted
    if (options?.signal?.aborted) {
      return {
        success: false,
        data: null,
        error: "Tool execution aborted",
      };
    }

    const startTime = Date.now();

    // For browser tool: inject the last known session ID if not provided
    let executionInput = input;
    if (toolName === "browser" && this.lastBrowserSessionId) {
      const action = String(input["action"] ?? "").trim().toLowerCase();
      // Don't override sessionId for launch action, but use it for other actions if missing
      if (action !== "launch" && !input["sessionId"]) {
        this.logger.info("Browser tool: injecting last session ID", {
          sessionId: this.lastBrowserSessionId,
          action
        });
        executionInput = { ...input, sessionId: this.lastBrowserSessionId };
      }
    }

    this.logger.info("Executing tool", { toolName, input: executionInput });

    try {
      const result = await tool.execute(executionInput);
      const executionTime = Date.now() - startTime;

      this.logger.info("Tool executed", {
        toolName,
        success: result.success,
        executionTime,
      });

      // Track browser sessions when launch succeeds or any action returns a sessionId
      if (toolName === "browser" && result.success) {
        const action = String(input["action"] ?? "").trim().toLowerCase();
        const data = result.data as Record<string, unknown> | undefined;
        const sessionId = data?.sessionId as string | undefined;

        if (action === "launch" && sessionId) {
          this.lastBrowserSessionId = sessionId;
          this.registerBrowserSession(sessionId, { launchedAt: new Date().toISOString() });
          this.logger.info("Browser launched: tracked session", { sessionId });
        } else if (action === "close") {
          // Clear the session ID when closing to prevent reuse of closed sessions
          this.logger.info("Browser closed: clearing session ID", { sessionId: this.lastBrowserSessionId });
          this.lastBrowserSessionId = undefined;
        } else if (sessionId && sessionId !== this.lastBrowserSessionId) {
          // Update if a different session is returned
          this.lastBrowserSessionId = sessionId;
          this.logger.debug("Browser session ID updated", { sessionId, action });
        }
      }

      return {
        ...result,
        metadata: { toolName, executionTime },
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error("Tool execution failed", { toolName, error: message });

      return {
        success: false,
        data: null,
        error: message,
        metadata: { toolName, executionTime },
      };
    }
  }

  listTools(): { name: string; description: string }[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  getTool(name: string): ToolExecutor | undefined {
    return this.tools.get(name);
  }

  /**
   * Execute multiple tool calls in parallel.
   * IMPORTANT: Browser tool calls are executed sequentially to maintain session state.
   * Returns array of results in the same order as input calls.
   */
  async executeBatch(
    calls: ToolCallWithId[],
    options?: { signal?: AbortSignal }
  ): Promise<Array<{ id: string; result: ToolResult }>> {
    const startTime = Date.now();

    // Separate browser calls from other calls - browser must be sequential
    const browserCalls = calls.filter((c) => c.toolName === "browser");
    const otherCalls = calls.filter((c) => c.toolName !== "browser");

    // Execute browser calls sequentially with session ID propagation
    const browserResults: Array<{ id: string; result: ToolResult }> = [];
    for (const call of browserCalls) {
      let callInput = call.input;

      // For browser calls (except launch), ALWAYS use the real session ID
      // The LLM might generate placeholder IDs like "browser_session", so override them
      const action = String(call.input["action"] ?? "").trim().toLowerCase();
      if (action !== "launch" && this.lastBrowserSessionId) {
        callInput = { ...call.input, sessionId: this.lastBrowserSessionId };
        this.logger.info("Browser call: using real session ID", {
          action,
          providedSessionId: call.input["sessionId"],
          realSessionId: this.lastBrowserSessionId,
          callId: call.id,
        });
      }

      // Execute with potentially modified input
      const result = await this.execute(call.toolName, callInput, options);

      // Update last session ID if this call returned a new one
      if (result.success && result.data) {
        const data = result.data as Record<string, unknown>;
        const sessionId = data.sessionId as string | undefined;
        // Check if this is a close action to clear the session ID
        if (action === "close") {
          this.lastBrowserSessionId = undefined;
          this.logger.debug("Browser closed in batch: cleared session ID");
        } else if (sessionId) {
          this.lastBrowserSessionId = sessionId;
          this.logger.debug("Updated last browser session ID", { sessionId });
        }
      }

      browserResults.push({ id: call.id, result });
    }

    // Execute non-browser calls in parallel
    const otherPromises = otherCalls.map(async (call) => ({
      id: call.id,
      result: await this.execute(call.toolName, call.input, options),
    }));

    const otherResults = await Promise.allSettled(otherPromises);
    const executionTime = Date.now() - startTime;

    // Create a map of results by call ID for O(1) lookup
    const browserResultMap = new Map(browserResults.map((r) => [r.id, r]));
    const otherResultMap = new Map(
      otherResults.map((result, index) => {
        const callId = otherCalls[index]?.id || `unknown_${index}`;
        if (result.status === "fulfilled") {
          return [callId, result.value];
        }
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return [
          callId,
          {
            id: callId,
            result: {
              success: false,
              data: null,
              error: `Batch execution failed: ${error}`,
              metadata: { toolName: otherCalls[index]?.toolName || "unknown", executionTime: 0 },
            } as ToolResult,
          },
        ];
      })
    );

    // Combine results in original call order
    const allResults: Array<{ id: string; result: ToolResult }> = [];
    for (const call of calls) {
      if (call.toolName === "browser") {
        const browserResult = browserResultMap.get(call.id);
        if (browserResult) {
          allResults.push(browserResult);
        }
      } else {
        const otherResult = otherResultMap.get(call.id);
        if (otherResult) {
          allResults.push(otherResult);
        }
      }
    }

    this.logger.info("Batch tool execution completed", {
      total: calls.length,
      browserCalls: browserCalls.length,
      otherCalls: otherCalls.length,
      executionTime,
    });

    return allResults;
  }
}
