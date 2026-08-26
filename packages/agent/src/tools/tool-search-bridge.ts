import type { ToolResult, ToolExecutor, ToolDefinition } from "@ducki/shared";
import type { Logger } from "@ducki/logger";

/**
 * Tool Search Bridge — Progressive Disclosure for Tool Schemas
 *
 * When the total tool schema tokens exceed a configurable threshold of the
 * context budget, non-core tools are hidden from the LLM's tool definitions.
 * Instead, three bridge tools are exposed:
 *
 *  - `tool_search`: search available tools by keyword/description
 *  - `tool_describe`: get the full schema for a specific tool
 *  - `tool_call`: execute a tool by name with arguments
 *
 * Core tools (filesystem, shell, browser, memory, task, project, etc.) are
 * always visible. Non-core tools (script-backed, optional, dynamic) are
 * deferred behind the bridge when the budget is exceeded.
 *
 * Inspired by hermes-agent's tool_search module which reduces schema tokens
 * by ~10% of context window when 70+ tools across 28 toolsets are available.
 */

/** Tools that are ALWAYS visible regardless of budget pressure. */
const CORE_TOOL_NAMES = new Set([
  "filesystem",
  "shell",
  "browser",
  "memory",
  "project",
  "task",
  "history",
  "git",
  "skill_manage",
  "workflow",
  "plan",
  "artifact",
  "vision",
  "explore",
  "gateway",
  // Bridge tools themselves are always visible when progressive disclosure is active
  "tool_search",
  "tool_describe",
  "tool_call",
]);

/** Threshold: when tool schema tokens exceed this fraction of context budget, activate progressive disclosure. */
const DEFAULT_BUDGET_THRESHOLD = 0.5;

/** Maximum number of search results to return. */
const MAX_SEARCH_RESULTS = 10;

/**
 * Estimate the number of tokens a tool definition consumes.
 * Uses a simple heuristic: ~4 chars per token (consistent with GPT/Claude).
 */
function estimateToolDefinitionTokens(def: ToolDefinition): number {
  const descTokens = Math.ceil(def.description.length / 4);
  const schemaTokens = Math.ceil(JSON.stringify(def.parameters).length / 4);
  return descTokens + schemaTokens + 10; // +10 for name and formatting overhead
}

/**
 * Estimate total tokens for an array of tool definitions.
 */
export function estimateTotalToolTokens(defs: ToolDefinition[]): number {
  return defs.reduce((sum, def) => sum + estimateToolDefinitionTokens(def), 0);
}

/**
 * Determine whether progressive disclosure should be activated based on
 * the total tool schema tokens vs the context budget.
 */
export function shouldActivateProgressiveDisclosure(
  allToolDefs: ToolDefinition[],
  contextBudgetTokens: number,
  threshold: number = DEFAULT_BUDGET_THRESHOLD
): { active: boolean; totalTokens: number; budgetTokens: number; thresholdPercent: number } {
  const totalTokens = estimateTotalToolTokens(allToolDefs);
  const budgetTokens = Math.floor(contextBudgetTokens * threshold);
  const active = totalTokens > budgetTokens;
  return {
    active,
    totalTokens,
    budgetTokens,
    thresholdPercent: threshold * 100,
  };
}

/**
 * Partition tool definitions into core (always visible) and deferred (behind bridge).
 */
export function partitionTools(defs: ToolDefinition[]): {
  core: ToolDefinition[];
  deferred: ToolDefinition[];
} {
  const core: ToolDefinition[] = [];
  const deferred: ToolDefinition[] = [];
  for (const def of defs) {
    if (CORE_TOOL_NAMES.has(def.name)) {
      core.push(def);
    } else {
      deferred.push(def);
    }
  }
  return { core, deferred };
}

// ──────────────────────────────────────────────────────────────────────────────
// Bridge tool executors
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build the `tool_search` tool definition.
 * Searches available tools by keyword against name and description.
 */
export function createToolSearchDefinition(): ToolDefinition {
  return {
    name: "tool_search",
    description:
      "Search available tools by keyword. Returns matching tool names with short descriptions. " +
      "Use this to discover tools that are not directly available in your tool list. " +
      "The search matches against tool names and descriptions.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keyword or phrase to match against tool names and descriptions",
        },
      },
      required: ["query"],
    },
  };
}

/**
 * Build the `tool_describe` tool definition.
 * Returns the full schema for a specific tool.
 */
export function createToolDescribeDefinition(): ToolDefinition {
  return {
    name: "tool_describe",
    description:
      "Get the full schema and description for a specific tool. " +
      "Use this after tool_search to understand a tool's parameters before calling it.",
    parameters: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: "The name of the tool to describe",
        },
      },
      required: ["tool_name"],
    },
  };
}

/**
 * Build the `tool_call` tool definition.
 * Executes a tool by name with arguments.
 */
export function createToolCallDefinition(): ToolDefinition {
  return {
    name: "tool_call",
    description:
      "Execute a tool by name with the given arguments. " +
      "Use tool_search to find the tool, then tool_describe to see its parameters, " +
      "then tool_call to execute it.",
    parameters: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: "The name of the tool to call",
        },
        arguments: {
          type: "object",
          description: "The arguments to pass to the tool (matching its schema)",
        },
      },
      required: ["tool_name", "arguments"],
    },
  };
}

/**
 * Create the three bridge tool executors.
 *
 * @param toolDefs - All tool definitions (including deferred ones) for the search index
 * @param getTool - Lookup function to resolve a tool name to its ToolExecutor at call time
 * @param logger - Logger instance
 */
export function createBridgeToolExecutors(
  toolDefs: ToolDefinition[],
  getTool: (name: string) => ToolExecutor | undefined,
  logger: Logger
): ToolExecutor[] {
  // Build a search index from tool definitions (excluding core tools and bridge tools)
  const searchIndex: Array<{ name: string; description: string; def: ToolDefinition }> = [];
  for (const def of toolDefs) {
    if (CORE_TOOL_NAMES.has(def.name)) continue;
    searchIndex.push({
      name: def.name,
      description: def.description,
      def,
    });
  }

  // ── tool_search ──────────────────────────────────────────────────────────
  const toolSearch: ToolExecutor = {
    name: "tool_search",
    description: createToolSearchDefinition().description,
    definition: createToolSearchDefinition(),
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const query = String(input["query"] ?? "").trim().toLowerCase();
      if (!query) {
        return { success: false, data: null, error: "query parameter is required" };
      }

      const terms = query.split(/\s+/).filter(Boolean);
      const matches = searchIndex.filter((entry) => {
        const haystack = `${entry.name} ${entry.description}`.toLowerCase();
        return terms.some((term) => haystack.includes(term));
      });

      const results = matches.slice(0, MAX_SEARCH_RESULTS).map((m) => ({
        name: m.name,
        description: m.description.slice(0, 120),
      }));

      logger.debug("[tool_search] query matched tools", { query, matchCount: results.length });

      return {
        success: true,
        data: {
          query,
          matchCount: results.length,
          totalAvailable: searchIndex.length,
          tools: results,
          hint: results.length === 0
            ? "No tools matched. Try broader keywords or use tool_describe with a known tool name."
            : `Found ${results.length} tool(s). Use tool_describe to see full schema, then tool_call to execute.`,
        },
      };
    },
  };

  // ── tool_describe ────────────────────────────────────────────────────────
  const toolDescribe: ToolExecutor = {
    name: "tool_describe",
    description: createToolDescribeDefinition().description,
    definition: createToolDescribeDefinition(),
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const toolName = String(input["tool_name"] ?? "").trim();
      if (!toolName) {
        return { success: false, data: null, error: "tool_name parameter is required" };
      }

      const tool = getTool(toolName);
      const def = tool?.definition ?? searchIndex.find((e) => e.name === toolName)?.def;
      if (!def) {
        // Suggest similar tools
        const suggestions = searchIndex
          .filter((e) => e.name.includes(toolName.slice(0, 4)) || toolName.includes(e.name.slice(0, 4)))
          .map((e) => e.name)
          .slice(0, 3);

        return {
          success: false,
          data: null,
          error: `Tool '${toolName}' not found.${suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : " Use tool_search to find available tools."}`,
        };
      }

      logger.debug("[tool_describe] describing tool", { toolName });

      return {
        success: true,
        data: {
          name: def.name,
          description: def.description,
          parameters: def.parameters,
          usage: `Use tool_call with tool_name="${def.name}" and arguments matching the schema above.`,
        },
      };
    },
  };

  // ── tool_call ────────────────────────────────────────────────────────────
  const toolCall: ToolExecutor = {
    name: "tool_call",
    description: createToolCallDefinition().description,
    definition: createToolCallDefinition(),
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const toolName = String(input["tool_name"] ?? "").trim();
      const args = input["arguments"];

      if (!toolName) {
        return { success: false, data: null, error: "tool_name parameter is required" };
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { success: false, data: null, error: "arguments must be an object matching the tool's schema" };
      }

      // Core tools shouldn't be called through the bridge — they're directly available
      if (CORE_TOOL_NAMES.has(toolName)) {
        return {
          success: false,
          data: null,
          error: `Tool '${toolName}' is a core tool and is directly available — no need to use tool_call.`,
        };
      }

      const tool = getTool(toolName);
      if (!tool) {
        return { success: false, data: null, error: `Tool '${toolName}' not found. Use tool_search to find available tools.` };
      }

      logger.info("[tool_call] executing deferred tool via bridge", { toolName, argKeys: Object.keys(args as Record<string, unknown>) });

      try {
        const result = await tool.execute(args as Record<string, unknown>);
        return result;
      } catch (error) {
        return {
          success: false,
          data: null,
          error: `Tool '${toolName}' execution failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };

  return [toolSearch, toolDescribe, toolCall];
}
