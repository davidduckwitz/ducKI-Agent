import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { getChatToolEventBroadcaster } from "./chat-tool-events.js";
import { getToolResponseHandler } from "./tool-staging/index.js";
import { TOOL_STAGING_TOOL_NAME } from "./tool-staging/tool-staging-tool.js";

const TOOL_TIMEOUT_WARNING = 5000; // 5 seconds

/** How much of a staged string payload still travels inline as a preview. */
const STAGED_PREVIEW_CHARS = 1200;

/**
 * Tells the model, in the tool result itself, that what it just received is incomplete
 * and names the exact follow-up call. Without this the agent saw a `tool-staging://` URL
 * it had no way to resolve and simply answered from the preview.
 */
function stagingNotice(stagingId: string, omittedChars: number): string {
  return [
    "",
    `[FULL RESULT AVAILABLE - ${omittedChars} more characters were NOT included above]`,
    `This is only a preview. The complete response is staged under id "${stagingId}".`,
    `Read it before answering: call the tool \`${TOOL_STAGING_TOOL_NAME}\` with {"action":"read","id":"${stagingId}"}`,
    `(then follow nextOffset for further chunks, or pass "search" to jump to a specific part).`,
    "Do not treat the task as finished until you have read what you need.",
  ].join("\n");
}

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

        // Staging the staging tool's own output would hide the very chunk the agent
        // just asked for behind another staging id - and loop.
        const canStage = handler && tool.name !== TOOL_STAGING_TOOL_NAME;

        if (result.success && canStage) {
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
            const stagingFields = {
              __toolStagingId: handled.stagingId,
              __toolStagingUrl: `tool-staging://${handled.stagingId}`,
              __toolStagingHint: stagingNotice(handled.stagingId, contentStr.length),
            };

            // A string payload used to be replaced wholesale by the staging markers, so
            // the entire output vanished from the agent's view. Keep it a string and keep
            // a readable head, with the pointer to the rest appended.
            if (typeof result.data === "string") {
              const preview = result.data.slice(0, STAGED_PREVIEW_CHARS);
              const omitted = result.data.length - preview.length;
              return {
                ...result,
                data: omitted > 0 ? `${preview}\n${stagingNotice(handled.stagingId, omitted)}` : result.data,
              };
            }

            const dataObj =
              typeof result.data === "object" && result.data !== null
                ? (result.data as Record<string, unknown>)
                : {};
            return {
              ...result,
              data: { ...dataObj, ...stagingFields },
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
