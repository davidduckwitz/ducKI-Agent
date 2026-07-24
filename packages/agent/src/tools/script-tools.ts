import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage, ToolExecutor, ToolResult } from "@ducki/shared";
import type { Logger } from "@ducki/logger";
import { runScriptInSandbox } from "@ducki/tools";
import { loadToolManifests, type ToolManifestEntry } from "./tool-registry.js";
import { RESERVED_TOOL_NAMES } from "./reserved-tool-names.js";

const DEFAULT_SUBAGENT_MAX_TOKENS = 800;
const DEFAULT_SUBAGENT_TIMEOUT_MS = parseInt(process.env["AGENT_SCRIPT_SUBAGENT_TIMEOUT_MS"] ?? "20000");

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export interface ScriptResultSubagentInput {
  toolName: string;
  instructions?: string;
  input: Record<string, unknown>;
  scriptResult: unknown;
  logs: string[];
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ScriptResultSubagentOutput {
  content: string;
  parsed?: unknown;
}

const SUBAGENT_PREAMBLE =
  "You are a result-interpretation subagent for a single tool call. A script already ran and produced a raw " +
  "result; your job is to turn it into the tool's final answer for the calling agent. Respond with the final " +
  "answer only - plain text, or a JSON object if structured data is more useful. Do not mention that you are a " +
  "subagent or describe your process.";

/**
 * One-shot interpretation call, same shape as Reasoner.reason()/Planner.createPlan(): a single
 * provider.generate() with no `tools` option, so the subagent can never itself trigger a tool call.
 */
export async function runScriptResultSubagent(
  getProvider: () => LLMProvider,
  logger: Logger,
  args: ScriptResultSubagentInput
): Promise<ScriptResultSubagentOutput> {
  const maxTokens = Math.min(Math.max(args.maxTokens ?? DEFAULT_SUBAGENT_MAX_TOKENS, 1), 4000);
  const timeoutMs = args.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;

  const systemContent = [SUBAGENT_PREAMBLE, args.instructions?.trim()].filter(Boolean).join("\n\n");
  const userContent = [
    `Tool: ${args.toolName}`,
    `Tool Input:\n${truncate(JSON.stringify(args.input ?? {}, null, 2), 4000)}`,
    `Script Result:\n${truncate(JSON.stringify(args.scriptResult ?? null, null, 2), 8000)}`,
    `Console Logs:\n${args.logs.length > 0 ? truncate(args.logs.slice(-50).join("\n"), 4000) : "(none)"}`,
  ].join("\n\n");

  const messages: LLMMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  const response = await withTimeout(
    getProvider().generate(messages, { temperature: 0.2, maxTokens }),
    timeoutMs,
    `Subagent interpretation for tool '${args.toolName}'`
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    parsed = undefined;
  }

  logger.debug("Script result subagent completed", { toolName: args.toolName, tokensUsed: response.usage?.totalTokens });
  return { content: response.content, parsed };
}

function buildScriptTool(
  manifest: ToolManifestEntry,
  parameters: Record<string, unknown>,
  getProvider: () => LLMProvider,
  logger: Logger
): ToolExecutor {
  const description = manifest.description ?? manifest.name;

  return {
    name: manifest.name,
    description,
    definition: { name: manifest.name, description, parameters },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      let scriptOutcome: { result: unknown; logs: string[] };
      try {
        const executed = runScriptInSandbox(
          manifest.script as string,
          { input, context: {} },
          { inputVar: "toolInput", contextVar: "toolContext" }
        );
        scriptOutcome = { result: executed.result ?? null, logs: executed.logs };
      } catch (error) {
        // Hard script failure: no subagent call, no LLM cost for a run that never produced a result.
        return { success: false, data: null, error: error instanceof Error ? error.message : String(error) };
      }

      if (!manifest.subagent) {
        return { success: true, data: { result: scriptOutcome.result, logs: scriptOutcome.logs } };
      }

      try {
        const interpreted = await runScriptResultSubagent(getProvider, logger, {
          toolName: manifest.name,
          instructions: manifest.instructions,
          input,
          scriptResult: scriptOutcome.result,
          logs: scriptOutcome.logs,
          maxTokens: manifest.subagentMaxTokens,
        });
        return {
          success: true,
          data: {
            interpreted: interpreted.parsed ?? interpreted.content,
            interpretedIsJson: interpreted.parsed !== undefined,
            result: scriptOutcome.result,
            logs: scriptOutcome.logs,
          },
        };
      } catch (error) {
        // Fail-soft: the script itself succeeded, so the caller still gets a usable result even
        // though the interpretation step (a separate LLM call) failed or timed out.
        logger.warn("Script tool subagent interpretation failed, returning raw script result", {
          name: manifest.name,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          success: true,
          data: {
            result: scriptOutcome.result,
            logs: scriptOutcome.logs,
            subagentFailed: true,
            subagentError: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}

/**
 * Turns every tools/<name>/TOOL.md manifest that declares a script into a real, callable
 * ToolExecutor - no hand-written TypeScript needed. A manifest without a script (the 15
 * hand-coded built-ins) is skipped here entirely; their execute() lives in packages/tools/src
 * instead. Requires a sibling parameters.json (fail-closed: warn + skip rather than register
 * a tool with a misleadingly empty schema).
 */
export function createScriptTools(getProvider: () => LLMProvider, logger: Logger, toolsRoot?: string): ToolExecutor[] {
  const manifests = loadToolManifests(toolsRoot);
  const tools: ToolExecutor[] = [];

  for (const manifest of manifests) {
    if (!manifest.script) continue;

    if (RESERVED_TOOL_NAMES.has(manifest.name)) {
      logger.warn("Skipping script tool - name is reserved for a built-in tool", { name: manifest.name });
      continue;
    }

    const parametersPath = join(dirname(manifest.path), "parameters.json");
    if (!existsSync(parametersPath)) {
      logger.warn("Skipping script tool - missing parameters.json", { name: manifest.name, expectedPath: parametersPath });
      continue;
    }

    let parameters: Record<string, unknown>;
    try {
      parameters = JSON.parse(readFileSync(parametersPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      logger.warn("Skipping script tool - invalid parameters.json", {
        name: manifest.name,
        expectedPath: parametersPath,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    tools.push(buildScriptTool(manifest, parameters, getProvider, logger));
  }

  return tools;
}
