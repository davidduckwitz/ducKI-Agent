import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { getChatToolEventBroadcaster } from "./chat-tool-events.js";
import { getToolResponseHandler } from "./tool-staging/index.js";

const TOOL_TIMEOUT_WARNING = 5000; // 5 seconds

/**
 * Wraps a tool to broadcast events and handle response staging
 */
export function createToolWrapper(tool: ToolExecutor): ToolExecutor {
  return {
    name: tool.name,
    description: tool.description,
    definition: tool.definition,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const broadcaster = getChatToolEventBroadcaster();
      const handler = getToolResponseHandler();

      // Broadcast tool start
      broadcaster?.broadcastToolStart(tool.name, undefined, input);

      const startTime = Date.now();
      let timeoutWarningEmitted = false;
      let timeoutHandle: NodeJS.Timeout | null = null;

      // Set up timeout warning (5 seconds)
      timeoutHandle = setTimeout(() => {
        if (!timeoutWarningEmitted) {
          timeoutWarningEmitted = true;
          broadcaster?.broadcastToolWarning?.(
            tool.name,
            `Tool is taking longer than ${TOOL_TIMEOUT_WARNING / 1000}s to complete`,
            Date.now() - startTime
          );
        }
      }, TOOL_TIMEOUT_WARNING);

      try {
        const result = await tool.execute(input);
        const duration = Date.now() - startTime;

        // Clear timeout warning if tool completes
        if (timeoutHandle) clearTimeout(timeoutHandle);

        if (result.success && handler) {
          // Handle response (inline or staged)
          const contentStr = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
          const handled = await handler.handle(tool.name, contentStr, { duration });

          // Broadcast tool complete
          broadcaster?.broadcastToolComplete(tool.name, handled.summary, undefined, {
            duration,
            outputSize: Buffer.byteLength(contentStr, "utf-8"),
            staged: handled.isStaged,
            stagingId: handled.stagingId,
          });

          // Return modified result with staging reference if needed
          if (handled.isStaged && handled.stagingId) {
            const dataObj = typeof result.data === "object" && result.data !== null
              ? result.data as Record<string, unknown>
              : {};
            return {
              ...result,
              data: {
                ...dataObj,
                __toolStagingId: handled.stagingId,
                __toolStagingUrl: `tool-staging://${handled.stagingId}`,
              },
            };
          }

          return result;
        } else if (!result.success) {
          // Broadcast error
          broadcaster?.broadcastToolError(tool.name, result.error ?? "Unknown error");
        }

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        const message = error instanceof Error ? error.message : String(error);

        // Clear timeout warning
        if (timeoutHandle) clearTimeout(timeoutHandle);

        // Broadcast error
        broadcaster?.broadcastToolError(tool.name, message);

        return {
          success: false,
          data: null,
          error: message,
        };
      }
    },
  };
}

/**
 * Wraps all tools in a list
 */
export function wrapTools(tools: ToolExecutor[]): ToolExecutor[] {
  return tools.map((tool) => createToolWrapper(tool));
}
