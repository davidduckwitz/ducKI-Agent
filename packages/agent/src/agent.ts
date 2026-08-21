import { jsonrepair } from "jsonrepair";
import type { LLMProvider } from "@ducki/providers";
import { isProviderConnectionError, isAbortError } from "@ducki/providers";
import type { LLMMessage, ToolResult, LLMContent, ToolCall } from "@ducki/shared";
import { tokenizeText } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { listPluginSkillDirs } from "./plugins/index.js";
import { randomUUID } from "node:crypto";
import { ConversationManager } from "./conversation/conversation.js";
import { MemorySystem } from "./memory/memory.js";
import { Planner, type Plan } from "./planner/planner.js";
import { createPlanTool, formatPlanAsMarkdown, toPlanEventPayload } from "./planner/plan-tool.js";
import { Executor } from "./executor/executor.js";
import { Reasoner } from "./reasoner/reasoner.js";
import { Reflection } from "./reflection/reflection.js";
import { Verifier } from "./verification/verifier.js";
import { ChecklistManager, type ChecklistItem } from "./checklist/checklist-manager.js";
import { CostTracker } from "./cost/cost-tracker.js";
import { History } from "./history/history.js";
import { createWorkflowTools } from "./workflow/workflow-tools.js";
import { resolveToolAlias, resolveToolAction, resolveCanonicalAction, TOOL_ACTION_ALIAS_MAP } from "./tools/tool-aliases.js";
import { summarizeToolCall } from "./tools/tool-summary.js";
import { loadToolManifests, isToolActive, createToolExecutorRegistry, type ToolManifestEntry, type ToolExecutorRegistry } from "./tools/tool-registry.js";
import { createScriptTools } from "./tools/script-tools.js";
import { createVisionTools } from "./vision/vision-tools.js";
import { ToolExecutionGraph } from "./executor/tool-graph.js";
import { skillSelector } from "./skill-selector/selector.js";
import { withManifestCache, listSkillMdFiles } from "./skill-selector/skill-cache.js";
import { taskRulesGuidance, platformHintGuidance, type PlatformChannel } from "./prompt/guidance-blocks.js";
import { ConversationCompressor } from "./conversation/compressor.js";
import { TokenCounter } from "./context/token-counter.js";
import { extractFileContent, EMPTY_CONTENT_ERROR, isIntentionalEmptyWrite } from "@ducki/tools";
import { modeDetector } from "./config/mode-detector.js";
import { toolTraceCollector } from "./executor/tool-traces.js";
import { createDynamicToolResolver } from "./dynamic-tools/dynamic-tool-resolver.js";
import { HookRegistry, type AgentHook } from "./hooks/agent-hooks.js";
import { AGENT_HOOK_NAMES } from "./hooks/hook-names.js";
import { EventEmitterV2, AGENT_EVENT_TYPES } from "./events/index.js";
import { InputNormalizerPipeline, AliasNormalizer, TypeCoercer, JSONRepairNormalizer } from "./tools/input-normalizer.js";
import type { ToolApprovalPolicy } from "./tools/tool-approval-policy.js";
import { createCompletionTool } from "./tools/completion-tool.js";
import { retryWithBackoff, DEFAULT_RETRY_CONFIG, adjustTimeoutForCompression } from "./utils/retry-utils.js";
import { ToolErrorTracker } from "./tool-error-tracking/tool-error-tracker.js";
import { FallbackResponseGenerator } from "./response/fallback-response-generator.js";
import { ToolCircuitBreaker } from "./tool-strategy/circuit-breaker.js";
import { FallbackToolExecutor } from "./tool-strategy/fallback-executor.js";
import { ToolHealthMonitor } from "./tool-health/tool-health-monitor.js";
import { ThinkBlockParser } from "./parsers/think-block-parser.js";
import { ToolDependencyChecker } from "./tool-strategy/tool-dependencies.js";

import { AgentOptions, AgentEventEmitter, AgentStatus, AgentRunResult, SkillManifest, SkillSummary, SkillScore, AgentRuntimeControls, AgentRunEvent, AgentRunContextCaps, AgentRunOptions, AgentRunEventType, RunJournalEntry } from "./config/interfaces_types";
// Event Emitter for Agent lifecycle events (chunk streaming, state updates)

/**
 * The tool-call format contract every parser in this file (extractToolCall,
 * extractHermesCall, parseLooseObject, ...) is built against. Exported so other
 * agent-like classes (e.g. CodingAgent) can compose it into their own system
 * prompt without risking drift from the actual parser behavior.
 */
/**
 * Read-only tool calls whose result is fully superseded by a later identical call.
 *
 * A coding run reads a file, edits it, and reads it again to check the edit - so the same file
 * lands in the context two or three times, and every later iteration pays for all of those
 * copies again. Only the newest one can possibly be accurate after an edit; the older ones are
 * pure cost AND a correctness hazard, because the model can quote a stale version of a file it
 * has already changed.
 *
 * Restricted to tools that only observe. A `write`, a shell command or an HTTP POST is an EVENT
 * - two identical calls are two things that happened, and collapsing them would rewrite history.
 */
const DEDUPABLE_READ_ONLY_CALLS: Record<string, ReadonlySet<string> | true> = {
  filesystem: new Set(["read", "list", "glob", "grep", "stat", "exists", "outline"]),
  git: new Set(["status", "diff", "log", "branch"]),
  diagnostics: true,
};

/**
 * True for a call that only observes. Shares DEDUPABLE_READ_ONLY_CALLS with the context
 * de-duplicator on purpose: "safe to collapse an older copy of" and "safe to run while the
 * tool is considered unhealthy" are the same property - the call changes nothing.
 */
export function isReadOnlyToolCall(toolName: string, input: Record<string, unknown>): boolean {
  const allowed = DEDUPABLE_READ_ONLY_CALLS[toolName];
  if (!allowed) return false;
  if (allowed === true) return true;
  return allowed.has(String(input["action"] ?? "").toLowerCase());
}

/**
 * True for a call that would persist a payload the model authored - i.e. one where an
 * incomplete payload means an incomplete artefact on disk.
 *
 * Deliberately narrow: only the filesystem writes. A truncated `shell` command or `grep` is
 * either syntactically broken (and fails loudly) or harmless, whereas a truncated file body
 * lands as a plausible-looking file nobody can tell is cut off.
 */
export function callWouldPersistContent(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== "filesystem") return false;
  const action = String(input["action"] ?? "").toLowerCase();
  return action === "write" || action === "append";
}

export function buildToolResultDedupeKey(
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  const allowed = DEDUPABLE_READ_ONLY_CALLS[toolName];
  if (!allowed) return undefined;

  if (allowed !== true) {
    const action = String(input["action"] ?? "").toLowerCase();
    if (!allowed.has(action)) return undefined;
  }

  // Key on the WHOLE input, key-sorted: a read of lines 1-100 and a read of lines 500-600 are
  // different information and must not collapse into one another. Only a byte-identical call
  // is treated as a repeat.
  const normalized = Object.keys(input)
    .filter((key) => input[key] !== undefined)
    .sort()
    .map((key) => `${key}=${JSON.stringify(input[key])}`)
    .join("&");

  return `${toolName}|${normalized}`;
}

export const TOOL_CALL_FORMAT_BLOCK = `## Tool Call Format - CRITICAL RULES
Emit tool calls EXACTLY in this format (JSON must be valid and complete):
[TOOL:toolName({"key": "value", "number": 123})]

Examples of CORRECT tool calls:
- [TOOL:task({"action": "create", "title": "My Task", "projectId": 1})]
- [TOOL:project({"action": "list"})]
- [TOOL:shell({"command": "ls -la"})]
- [TOOL:browser({"action": "screenshot", "sessionId": "browser_session"})]

CRITICAL FOR BROWSER TASKS: ALWAYS capture screenshots AFTER navigating to a page:
1. [TOOL:browser({"action": "launch"})]
2. [TOOL:browser({"action": "goto", "sessionId": "browser_session", "url": "..."})]
3. [TOOL:browser({"action": "screenshot", "sessionId": "browser_session"})]  ← REQUIRED to see page
4. Analyze the screenshot content
5. Take action based on what you see

Rules:
1. ALL JSON keys must be in double quotes ("key" not 'key' or key)
2. JSON values must be properly escaped and typed (strings in quotes, numbers without quotes)
3. Do NOT use {json: ...} or {args: ...} - put the actual key-value pairs
4. If multiple independent tool calls needed (no dependencies), emit multiple [TOOL:...] markers in same response
5. For dependent calls (result needed as input), emit one at a time and wait for result
6. Always close with )] - never leave it hanging
7. When reporting a tool's result back to the user, copy exact values (numbers, times, dates, names) directly from the tool result - never recalculate, estimate, or recall them from your own knowledge
8. NEVER write text claiming a tool ran, a file was written, or work was "submitted"/"completed" unless you emitted the actual [TOOL:...] marker IN THIS SAME RESPONSE. A sentence like "The X tool was executed" or "all files were submitted as the final solution" with no marker present is a lie - nothing happened. Only use a tool name that is actually in your tool list; do not invent one or reuse a real tool for an unrelated purpose (e.g. "gateway" sends outbound messages to Discord/Telegram/webhooks - it does not write files).

## Writing files - USE THE BLOCK FORMAT (strongly preferred)
When writing a file (code, HTML, JSON, any multi-line content), DO NOT embed the content inside JSON. Use the block form instead - the content is taken EXACTLY as written, with no escaping:
[TOOL:filesystem action=write path=index.html]
<!doctype html>
<html>
  <body>Hello</body>
</html>
[/TOOL]
Rules for the block form:
- The header line holds only simple values as key=value (action, path). No JSON, no ( or { on the header line.
- NEVER mix the two forms. A header with PARENTHESES followed by raw content on the next lines is
  invalid: parentheses belong to the JSON form, which carries its content INSIDE the JSON. Either
  put everything in the JSON argument, or use the block header without parentheses and close it
  with [/TOOL].
- Everything between the header line and [/TOOL] is the literal file content - do NOT escape newlines or quotes, do NOT wrap it in JSON.
- Always end the block with a line containing exactly [/TOOL].
- This avoids the #1 write failure: broken JSON escaping that corrupts the file. Prefer it for every write/append.

If you are instead given tools as a structured/native function-calling list (not writing [TOOL:...] text yourself), the block form above does not apply - there is no heredoc body in a native call. In that case you MUST put the ENTIRE file content as a plain JSON string in the tool's "content" argument, in the SAME call as "action" and "path" - never omit it, never send it in a separate message, and never just describe the file in your own text. A write/append call with no "content" argument does nothing and fails.`;

const DEFAULT_SYSTEM_PROMPT = `You are DucKI, an intelligent AI coding and task agent. You are helpful, accurate, and professional.
Use the available tools to create and manage projects and tasks, then work them through to completion.
When a request needs execution, plan first, create or update project/task records as needed, then use tools to carry out the work.
Always think step-by-step, keep state in the database, and return concise progress updates.
Use ./shared-workspace as collaborative file area for user-provided artifacts and generated deliverables.

CRITICAL: When you say you will do something (e.g., "I will create a file", "I will send to Discord"), you MUST emit the actual [TOOL:...] calls immediately - DO NOT just describe what you will do. Every action must be followed by its tool call.

IMPORTANT: NEVER repeat the same tool call twice in the same conversation. Once you call a tool, you have already executed it - do not call it again unless the result indicates failure. If you need to use a tool again with different parameters, that's OK, but with the SAME parameters, skip it.

## Real-Time Data Queries
For queries requiring CURRENT/REAL data (not LLM training data), ALWAYS use tools:
- Current date/time: Use shell tool (e.g., "date" or "Get-Date" command)
- Current file contents: Use file-read tool (do NOT use memory/conversation context)
- Current system state: Use shell or system tools
- Current web PAGE content (a specific site, a screenshot): Use the browser tool
- Current news / headlines / world events: Use the dedicated news tool (see below). It returns real, current headlines - NEVER say you have no news access.
- Current facts from a public API (weather, exchange rates, etc.): Use the http tool to fetch a free, no-key API directly
DO NOT answer these from conversation memory or LLM knowledge alone - execute tools to get actual current data.

### Weather
For any weather question, use the dedicated weather tool with just the city name - it geocodes and fetches current conditions + a short outlook in one call (free, no key). Do NOT ask the user for measurements, a date, or a station id.
   [TOOL:weather({"location": "Fulda"})]
Then report the "summary" field (or temperature/wind/precipitation from the "current" object). Only fall back to the http tool + a public API if the weather tool is unavailable. If no city was given, ask ONLY for the city - nothing else.

### News & current events
For ANY request about the news, headlines, "die neuesten/wichtigsten Nachrichten", world/current events, or news on a country/topic, use the dedicated news tool - do NOT scrape websites and NEVER claim you lack a news feed:
   [TOOL:news({"action": "fetch", "source": "all", "count": 10})]
For a specific topic/country add "query" (e.g. [TOOL:news({"action": "fetch", "source": "all", "query": "ukraine", "count": 10})]). Report the returned articles (title, source, time). The news tool IS your real-time news access.

### Never refuse a real-time request (CRITICAL)
You DO have live access through tools. NEVER tell the user you cannot get news/weather/prices/current data, never ask them to paste "the source content", and never ask for a date you can default to today. When a request maps to a tool (news, weather, exchange_rates, http, browser, shell), CALL that tool instead of explaining a limitation. For a combined request (e.g. "news, weather and system info"), call each relevant tool and then answer with the combined results. The only detail you may briefly ask for is a missing city for weather.

### Data-SOURCE tools vs data-CONSUMER tools (CRITICAL)
A tool whose inputs are the very data the user is asking for is a CONSUMER (it processes/summarizes data you already have), NOT a source. Example: a "weather_summary" tool that requires temperature/precipitation/station_id as input cannot fetch the weather - it summarizes weather you already fetched. When a request needs live data, first FETCH it (http/browser/shell), then optionally pass it to a consumer tool. Never tell the user you cannot get the data because a consumer tool needs inputs - get the data yourself with the http/browser/shell tools.

## Reading files - line numbers are DISPLAY ONLY
The filesystem tool's "read" action prefixes every line as "<n>: content". Those numbers are NOT
part of the file:
- When passing text back to "edit" as oldString, copy only what comes AFTER "<n>: ".
- When writing content with "write"/"append", never include them - doing so corrupts the file.
- Use them to target the next read (offset) and to map an error like "app.ts(42,5)" onto a line.
- For a large file, "outline" lists its functions/classes with line numbers for a fraction of the
  tokens of a full read; read only the region you actually need afterwards.
- Prefer "grep"/"glob" to locate something over reading files speculatively, and emit independent
  reads in ONE response so they run as a single batch.

## Responding to Tool Results - CRITICAL
When you receive tool execution results (messages marked as "tool" role):
1. ALWAYS analyze what each tool returned
2. Synthesize the results into a coherent summary
3. Answer the user's original question based on the actual results
4. If a tool returned an error, READ the error message: our tools name the corrective action
   (e.g. "is a directory ... use action:'list'", "pass recursive:true", "oldString is not unique").
   Retry with that correction instead of reporting the raw error or giving up. Only report a
   failure to the user once a corrected retry also failed.
5. Do NOT emit only a tool call and then go silent - you MUST provide a response after tools execute
6. If multiple tools were executed, summarize their combined results together

## Large Tool Results (CRITICAL)
Responses larger than ~5KB are NOT delivered inline. You only receive a preview plus a staging id,
marked with "[FULL RESULT AVAILABLE" or a "__toolStagingId" field.
When you see that marker the task is NOT finished - the data you need is not in the message yet:
1. Call [TOOL:tool_staging({"action": "read", "id": "<the staging id>"})] to read the content
2. Continue with {"action": "read", "id": "...", "offset": <nextOffset>} while "hasMore" is true,
   or use {"action": "read", "id": "...", "search": "<term>"} to jump straight to what you need
3. Only answer once you have read the parts relevant to the user's question
Paging through a staged result with different offsets is NOT a repeated tool call - it is required.
Never answer from the preview alone, and never claim a result is empty because it was staged.

## Browser Tool Workflow (IMPORTANT - READ CAREFULLY)

### FASTEST PATH - use a macro action for the two most common needs
Before chaining separate launch/goto/screenshot/evaluate calls, check if one of these covers
what you need - each is a SINGLE tool call, so there is no sessionId to track or propagate at all:
- "I need to see a page" -> action="screenshot_url": launches (or reuses) a session, navigates,
  optionally waits, captures a screenshot, and (if close:true) tears the session down again -
  all in one call.
  [TOOL:browser({"action": "screenshot_url", "url": "https://example.com"})]
- "I need to check/test a page" -> action="verify_page": optional navigate, optional wait for a
  selector, optional JS check script, plus title/URL/text-excerpt - returns passed:true/false
  when you gave a selector or script. Use this after writing a file (e.g. index.html) to confirm
  it actually works, instead of separate goto+wait+evaluate calls.
  [TOOL:browser({"action": "verify_page", "url": "http://localhost:5173", "selector": "#app"})]
Both accept sessionId to target an existing session instead of launching a new one.

### Launch can navigate directly
action="launch" accepts url and will go there immediately - use this instead of a separate goto
whenever you're opening a fresh session at a known URL:
[TOOL:browser({"action": "launch", "url": "https://example.com"})]

### Live preview (only if the user asked to watch the browser, or you need MANY screenshots)
action="stream_start" begins a live view of a session that the user can watch in the UI (a
floating window they opened, or one you offer them). Once streaming, action="screenshot" with
preferLive:true returns the most recent live frame instantly instead of capturing a new
full-page screenshot - much cheaper when you need to check the page repeatedly (e.g. after
each of several clicks), at the cost of being viewport-only, not the full scroll height.
Call action="stream_stop" when you're done (or just action="close" the session). Don't start a
stream for a single one-off screenshot - screenshot_url is the right tool for that.

### Multi-step interactions (click, type, form_fill, login, multiple screenshots) still need the
### full sequence - emit ALL of these calls in ONE turn, sequentially:
The backend executor:
1. Executes browser calls SEQUENTIALLY (not in parallel)
2. Extracts the REAL sessionId from "launch"'s result automatically
3. Overrides whatever sessionId you wrote on every subsequent browser call in that batch with
   the real one - so you can use ANY placeholder value (e.g. "browser_session") on goto/click/
   screenshot/close and it will still resolve correctly
4. Feeds each call's actual result (not a guess) into your next iteration

Correct workflow (all calls in one response):
1. [TOOL:browser({"action": "launch"})]
2. [TOOL:browser({"action": "goto", "sessionId": "browser_session", "url": "https://example.com"})]
3. [TOOL:browser({"action": "click", "sessionId": "browser_session", "selector": "#submit"})]
4. [TOOL:browser({"action": "screenshot", "sessionId": "browser_session"})]
5. [TOOL:browser({"action": "close", "sessionId": "browser_session"})]

### Key Rules (apply to every browser call, macro or multi-step):
- Emit all browser calls for one logical task in ONE turn - never split launch/goto/screenshot
  across separate turns; the session id is real either way, but the page state you're reacting
  to (an error, a loaded selector) is only visible once its result comes back
- Launch MUST be first if you need a new session and aren't using screenshot_url/verify_page
- Do NOT invent or guess a sessionId, a URL, or a screenshot result - always use the value the
  tool actually returned in its result, never one you recalled or assumed
- If you see "session not found", ensure launch (or a macro action) ran first in your sequence

## Large File Writing Strategy (CRITICAL)
Use chunking for files larger than 200 lines (HTML), 300 lines (JavaScript), or 500 lines (JSON).

Process: Part 1 uses write action to create file. Part 2+ use append action to add content.
Wait for response after each part before proceeding. Report progress after each part.

Critical: In JSON strings, newlines must be escaped as backslash-n (not literal newlines).
Quotes must be backslash-escaped. Backslashes must be backslash-escaped.
Use json-tool-format skill for validation.

Never write entire large file in one call - causes truncation and JSON corruption.
Never mix write and append in same response - wait for response between them.

## Vision and Image Support
You can receive and analyze images in the conversation. This includes:
- User-provided images for analysis or processing
- Automatic browser screenshots captured during development/testing
- Visual feedback on UI/design changes

When you receive an image, analyze it carefully and provide insights about:
- Visual layout and design
- Content and text visible in screenshots
- Errors or issues shown visually
- Progress of visual tasks

Use visual information to make better decisions about browser interactions and UI testing.

${TOOL_CALL_FORMAT_BLOCK}`;


export class Agent {
  readonly name: string;
  private status: AgentStatus = "idle";
  private systemPrompt: string;
  private maxIterations: number;
  private timeoutMs: number;
  private enableReflection: boolean;
  private enablePlanning: boolean;
  private enableAutoMemory: boolean;
  private disableQualityPasses: boolean;

  private conversation: ConversationManager;
  private memory: MemorySystem;
  private planner: Planner;
  readonly executor: Executor;
  private toolRegistry: ToolExecutorRegistry;
  private reasoner: Reasoner;
  private reflection: Reflection;
  private verifier: Verifier;
  private checklistManager: ChecklistManager;
  private costTracker?: CostTracker;
  private visionEnabled = true;
  private history: History;
  private thinkBlockParser: ThinkBlockParser;
  private logger: Logger;
  private skillsRoot: string;
  private stopRequested = false;
  /** Aborts the in-flight LLM request the moment stop() is called or the progress timeout
   *  fires. Without this, stopRequested is only checked between loop iterations, so a long
   *  in-flight generation (or one stuck in a reasoning loop) keeps running to completion
   *  unseen even after the user clicked Stop. */
  private abortController: AbortController | undefined;
  private toolGraph: ToolExecutionGraph;
  /** Skills loaded into the current/most recent run's prompt - lets resolveToolNameAndInput
   *  recognize a model calling a skill's slug directly (e.g. [TOOL:datum-uhrzeit-tag()])
   *  instead of the documented skill_manage(action:"execute") wrapper, which smaller/local
   *  models routinely do once a skill is merely visible in context. */
  private activeSkillSlugsForRun = new Set<string>();
  private conversationCompressor: ConversationCompressor;
  private readonly maxConsecutiveToolFailures = parseInt(process.env["AGENT_MAX_TOOL_FAILURES"] ?? "3");
  private readonly maxRepeatedToolCall = parseInt(process.env["AGENT_MAX_REPEATED_TOOL_CALL"] ?? "3");
  private readonly enableAutoSkillSelection =
    (process.env["AGENT_AUTO_SKILL_SELECTION"] ?? "true").toLowerCase() !== "false";
  private readonly autoSkillScoreThreshold = parseFloat(process.env["AGENT_AUTO_SKILL_THRESHOLD"] ?? "0.78");
  private readonly autoSkillMarginThreshold = parseFloat(process.env["AGENT_AUTO_SKILL_MARGIN"] ?? "0.2");
  private readonly autoSkillMinInputLength = parseInt(process.env["AGENT_AUTO_SKILL_MIN_INPUT_LEN"] ?? "20");
  private readonly autoSkillMinOverlap = parseInt(process.env["AGENT_AUTO_SKILL_MIN_OVERLAP"] ?? "2");
  private autoSkillSelectionAttempts = 0;
  private autoSkillSelections = 0;
  private currentScreenshotMessage: LLMMessage | undefined;

  /**
   * Serializes the fire-and-forget event inserts in `emit()`. libsql is genuinely async, so
   * firing several inserts without awaiting let them land in an order that did not match the
   * order the events were emitted in - and the row id IS the timeline order the chat UI pages
   * through. Chaining them keeps insertion order == emit order without making emit() block.
   */
  private eventPersistQueue: Promise<unknown> = Promise.resolve();

  // Phase 1: Hook system and granular events
  private hookRegistry: HookRegistry;
  private eventEmitterV2: EventEmitterV2;

  // Phase 2: Tool approval policies and input normalization
  private toolApprovalPolicy: ToolApprovalPolicy | undefined;
  private inputNormalizer: InputNormalizerPipeline;

  // Phase 1 Resilience: Error tracking and fallback response generation
  private toolErrorTracker: ToolErrorTracker;
  private fallbackResponseGenerator: FallbackResponseGenerator;

  // Phase 2 Resilience: Circuit breaker and fallback executor
  private circuitBreaker: ToolCircuitBreaker;
  private fallbackExecutor: FallbackToolExecutor;

  // Phase 4 Monitoring: Tool health and dependencies
  private toolHealthMonitor: ToolHealthMonitor;
  private toolDependencyChecker: ToolDependencyChecker;

  constructor(
    private readonly provider: LLMProvider,
    private readonly db: DatabaseService,
    private readonly eventEmitter: AgentEventEmitter | undefined = undefined,
    options: AgentOptions = {}
  ) {
    this.name = options.name ?? "DucKI";
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxIterations = options.maxIterations ?? parseInt(process.env["AGENT_MAX_ITERATIONS"] ?? "50");
    this.timeoutMs = options.timeoutMs ?? parseInt(process.env["AGENT_TIMEOUT_MS"] ?? "600000");
    this.enableReflection = options.enableReflection ?? (process.env["AGENT_ENABLE_REFLECTION"] ?? "true").toLowerCase() !== "false";
    this.enablePlanning = options.enablePlanning ?? true;
    this.enableAutoMemory = options.enableAutoMemory ?? (process.env["AGENT_AUTO_MEMORY"] ?? "true").toLowerCase() !== "false";
    this.disableQualityPasses = options.disableQualityPasses ?? false;

    this.logger = getRootLogger().child(`Agent:${this.name}`);
    const configuredSkillsPath = process.env["SKILLS_PATH"]?.trim();
    if (configuredSkillsPath) {
      this.skillsRoot = resolve(configuredSkillsPath);
    } else {
      const monorepoCandidate = resolve(process.cwd(), "../../skills");
      const cwdLocal = resolve(process.cwd(), "skills");
      this.skillsRoot = existsSync(monorepoCandidate) ? monorepoCandidate : existsSync(cwdLocal) ? cwdLocal : cwdLocal;
    }

    // Phase 1: Initialize hook registry and event emitter V2
    this.hookRegistry = new HookRegistry(this.logger);
    if (options.hooks) {
      // AgentOptions.hooks is a flat AgentHook[] with no lifecycle-event field, so the only
      // event they can be registered under is beforeTool - the sole consumer today
      // (executeToolCallsFromResponse) and the only shape every existing hook handler expects
      // (reads context.toolName/context.input). Registering under `hook.name` (the hook's own
      // identifier, e.g. "coding-discipline-read-before-edit") instead of the event name was the
      // bug: executeHooks(AGENT_HOOK_NAMES.BEFORE_TOOL, ...) looks up the "beforeTool" bucket,
      // which stayed empty, so every hook passed this way was silently never invoked.
      for (const hook of options.hooks) {
        this.hookRegistry.register(AGENT_HOOK_NAMES.BEFORE_TOOL, hook);
      }
    }

    this.eventEmitterV2 = new EventEmitterV2({
      onEvent: (event) => {
        // Emit to both new V2 system and legacy eventEmitter (backward compat)
        this.eventEmitter?.emitEvent(event as AgentRunEvent);
      },
      onChunk: (chunk) => {
        this.eventEmitter?.emitChunk?.(chunk);
      },
    });

    // Phase 2: Initialize input normalization pipeline
    this.inputNormalizer = new InputNormalizerPipeline(this.logger);
    this.inputNormalizer.addNormalizer(new AliasNormalizer());
    this.inputNormalizer.addNormalizer(new TypeCoercer());
    this.inputNormalizer.addNormalizer(new JSONRepairNormalizer());

    // Phase 1 Resilience: Initialize error tracking and fallback response
    this.toolErrorTracker = new ToolErrorTracker(this.logger);
    this.fallbackResponseGenerator = new FallbackResponseGenerator(this.logger);

    // Phase 2 Resilience: Initialize circuit breaker and fallback executor
    this.circuitBreaker = new ToolCircuitBreaker(this.logger);

    // Phase 4 Monitoring: Initialize tool health monitor and dependency checker
    this.toolHealthMonitor = new ToolHealthMonitor(this.logger);
    this.toolDependencyChecker = new ToolDependencyChecker(
      this.logger,
      new Set(),
      new Set()
    );

    this.conversation = new ConversationManager(db, this.logger);
    this.memory = new MemorySystem(db, this.logger);
    this.planner = new Planner(provider, this.logger);

    // Initialize executor with event callbacks for real-time UI updates (WebSocket streaming)
    this.executor = new Executor(this.logger, createDynamicToolResolver(db), {
      onToolStart: (toolName, input) => {
        this.eventEmitterV2.emitEvent({
          type: "tool_execution_started",
          message: `Executing ${toolName}`,
          data: { toolName, input },
          timestamp: new Date().toISOString(),
        });
      },
      onToolProgress: (toolName, progress) => {
        this.eventEmitterV2.emitEvent({
          type: "tool_call",
          message: `${toolName}: ${progress}`,
          data: { toolName, progress },
          timestamp: new Date().toISOString(),
        });
      },
      onToolComplete: (toolName, summary, duration, outputSize) => {
        this.eventEmitterV2.emitEvent({
          type: "tool_execution_completed",
          message: summary,
          data: { toolName, summary, duration, outputSize },
          timestamp: new Date().toISOString(),
        });
      },
      onToolError: (toolName, error) => {
        this.eventEmitterV2.emitEvent({
          type: "tool_execution_failed",
          message: `${toolName} failed: ${error}`,
          data: { toolName, error },
          timestamp: new Date().toISOString(),
        });
      },
      onToolDisposition: (toolName, disposition) => {
        this.logger.debug("Tool disposition", { toolName, disposition });
      },
    });

    // Phase 2 Resilience: Initialize fallback executor with the executor instance
    this.fallbackExecutor = new FallbackToolExecutor(
      this.executor,
      this.logger,
      this.eventEmitterV2
    );

    // Phase 3B: Register completion tools
    this.executor.registerTool(createCompletionTool({ name: "submit_solution", completesRun: true }));

    for (const tool of createWorkflowTools(db)) {
      this.executor.registerTool(tool);
    }
    for (const tool of createScriptTools(() => this.provider, this.logger)) {
      this.executor.registerTool(tool);
    }
    // Phase 4 "Observer": visual reasoning over screenshots (needs a vision model).
    // Gated by AGENT_ENABLE_VISION via the visionEnabled getter, refreshed per run.
    for (const tool of createVisionTools(() => this.provider, this.logger, () => this.visionEnabled)) {
      this.executor.registerTool(tool);
    }
    this.executor.registerTool(createPlanTool(() => this.provider, this.logger));
    this.toolRegistry = createToolExecutorRegistry(
      (name) => this.executor.getTool(name),
      createDynamicToolResolver(db),
      this.logger
    );
    this.reasoner = new Reasoner(provider, this.logger);
    this.reflection = new Reflection(provider, this.logger);
    // Phase 1 "Critic": structured per-constraint verification. No shell executor
    // is wired in yet, so shell-check/unit-test constraints report as "skipped"
    // rather than running arbitrary commands outside the tool sandbox.
    this.verifier = new Verifier(provider, this.logger);
    // Session checklist: externalizes open-goal state so the run-loop can focus on and
    // verify one plan step at a time. DatabaseService structurally satisfies ChecklistStore.
    this.checklistManager = new ChecklistManager(this.db, this.logger);
    this.history = new History();
    this.thinkBlockParser = new ThinkBlockParser();
    this.toolGraph = new ToolExecutionGraph();
    this.conversationCompressor = new ConversationCompressor(provider);
  }

  async startConversation(options: { name?: string; projectId?: number } = {}): Promise<number> {
    return this.conversation.start(options);
  }

  async loadConversation(id: number): Promise<void> {
    await this.conversation.load(id);
    // Sync history with loaded conversation so mode detection has context
    // This prevents lightweight mode from being incorrectly selected for old chats
    const messages = this.conversation.getMessages();
    this.history.clear();
    for (const msg of messages) {
      this.history.add(msg, msg.role === "tool" ? "tool" : undefined);
    }
    this.logger.info("History synced after loading conversation", {
      conversationId: id,
      messageCount: messages.length,
    });
  }

  /**
   * Executes a single tool directly, bypassing the LLM entirely - the surface behind the
   * chat UI's "/" tool selector's "run now" action. Reuses resolveToolNameAndInput and
   * preflightToolInput (the same alias-resolution and validation used for LLM-issued tool
   * calls) so a directly-run tool gets identical projectId->id mapping, action-alias
   * resolution, and required-field checks - the UI shouldn't have a laxer path than the
   * agent's own tool-call loop. If a conversation is loaded, the call is persisted as an
   * "event" message so it renders in chat history the same way an agent-issued tool call
   * would (and survives a reload).
   */
  async executeToolDirect(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<ToolResult & { toolName: string }> {
    const controls = await this.loadRuntimeControls();
    const resolved = this.resolveToolNameAndInput(toolName, input);
    const preflight = await this.preflightToolInput(resolved.toolName, resolved.input, controls);

    if (!preflight.ok) {
      return { success: false, data: null, error: preflight.error, toolName: resolved.toolName };
    }

    const result = await this.executor.execute(resolved.toolName, preflight.input);

    // A plan produced by directly running the "plan" tool (chat "Tools" menu) must
    // reach the UI's plan panel just like plan mode does, otherwise the plan is
    // buried in the tool-result JSON and can't be viewed or executed. Emit the same
    // source:"plan_mode" event on the shared bus the websocket handler forwards.
    if (resolved.toolName === "plan" && result.success) {
      const data = result.data as { plan?: unknown; markdown?: string } | undefined;
      if (data?.plan && typeof data.plan === "object") {
        try {
          const markdown = typeof data.markdown === "string"
            ? data.markdown
            : formatPlanAsMarkdown(data.plan as Plan);
          this.eventEmitterV2.emitEvent({
            type: "plan" as AgentRunEventType,
            message: "Plan erstellt",
            data: { ...toPlanEventPayload(data.plan as Plan, markdown), phase: "done", iteration: 0 },
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          this.logger.warn("Failed to emit plan panel event for direct plan tool", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (this.conversation.id !== undefined) {
      try {
        await this.db.addMessage({
          conversationId: this.conversation.id,
          role: "event",
          content: `Tool "${resolved.toolName}" direkt ausgefuehrt`,
          toolResult: JSON.stringify({
            eventType: "tool_result",
            data: { toolName: resolved.toolName, input: preflight.input, ...result },
            timestamp: new Date().toISOString(),
          }),
        });
      } catch {
        // Persistence failures should not block returning the tool result to the caller.
      }
    }

    return { ...result, toolName: resolved.toolName };
  }

  async run(
    userInput: string,
    options: AgentRunOptions = {}
  ): Promise<AgentRunResult> {
    if (this.status === "running") {
      throw new Error("Agent is already running");
    }

    this.stopRequested = false;
    this.abortController = new AbortController();
    this.status = "running";
    const toolsUsed: string[] = [];
    let iterations = 0;
    const controls = await this.loadRuntimeControls();
    // A caller-scoped timeout (e.g. EXECUTION_MODE_TIMEOUT_MINUTES for plan execution)
    // takes precedence over the agent-wide AGENT_TIMEOUT_MS default for this run only.
    if (options.timeoutMsOverride && options.timeoutMsOverride > 0) {
      controls.timeoutMs = options.timeoutMsOverride;
    }

    // Load ever-used skills for scoring boost (non-blocking)
    try {
      const everUsedSkills = await this.db.getEverUsedSkills();
      skillSelector.setEverUsedSkills(everUsedSkills);
    } catch (error) {
      this.logger.warn("Failed to load ever-used skills", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Phase 1: Clear tool error tracking for new conversation
    this.toolErrorTracker.clear();

    // Phase 2: Reset circuit breakers for new conversation
    this.circuitBreaker.resetAll();

    // === PRE-FLIGHT TOOLS: Execute real-time data queries before LLM inference ===
    // This prevents hallucination about current state (time, date, system status, etc.)
    // Best practice: gather ground truth before letting LLM reason
    await this.executePreFlightTools(userInput, options);

    let timedOut = false;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let rejectTimeout: ((error: Error) => void) | undefined;

    const wrappedOptions: AgentRunOptions = {
      ...options,
      onChunk: (chunk) => {
        armTimeout();
        try {
          this.eventEmitter?.emitChunk(chunk);
        } catch (e) {
          console.error("Error emitting chunk event:", e);
        }
        // Always forward to the caller-provided callback so streaming works
        // whether or not an eventEmitter is wired to this agent instance.
        options.onChunk?.(chunk);
      },
      onEvent: async (event) => {
        armTimeout();
        try {
          this.eventEmitter?.emitEvent(event);
        } catch (e) {
          console.error("Error emitting event:", e);
        }
        await options.onEvent?.(event);
      },
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });

    const armTimeout = () => {
      if (settled) return;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(() => {
        if (settled || timedOut) return;
        timedOut = true;
        this.stopRequested = true;
        this.abortController?.abort();
        wrappedOptions.onEvent?.({
          type: "guardrail",
          message: `Agent progress timeout after ${controls.timeoutMs}ms`,
          data: { timeoutMs: controls.timeoutMs },
          timestamp: new Date().toISOString(),
        });
        rejectTimeout?.(new Error(`Agent timeout after ${controls.timeoutMs}ms without progress`));
      }, controls.timeoutMs);
    };

    armTimeout();
    const runLoopPromise = this.runLoop(userInput, toolsUsed, iterations, controls, wrappedOptions);
    // If the timeout wins the race below, runLoop keeps executing until it observes
    // stopRequested. Swallow any late rejection so it never surfaces as an unhandled
    // rejection (the race already propagated the timeout error to the caller).
    void runLoopPromise.catch((error) => {
      if (!settled) return;
      this.logger.warn("Agent run loop settled after timeout/stop", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    try {
      const result = await Promise.race([runLoopPromise, timeoutPromise]);
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.status = this.stopRequested ? "stopped" : "idle";
      return result;
    } catch (error) {
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.status = timedOut || this.stopRequested ? "stopped" : "error";
      throw error;
    }
  }

  private normalizeToolCallText(value: string): string {
    return value
      // Decode Hermes quote markers
      .replaceAll('<|"|>', '"')
      .replaceAll("<|'|>", "'")
      // Normalize quoted keys back to quoted keys (for JSON compatibility)
      // Keep both quoted and unquoted as-is to support loose JSON parsing
      .trim();
  }

  /**
   * Escapes raw control characters (newline, carriage return, tab) that appear *inside*
   * double-quoted string literals, converting them to their JSON escape sequences
   * (`\n`, `\r`, `\t`). Control characters outside strings (formatting between tokens)
   * are left untouched. String state honours backslash escaping so an already-escaped
   * `\"` does not prematurely close a string and a literal `\\` is not misread.
   *
   * This exists because local models routinely put real line breaks into large string
   * values (typically a write_file `content`) instead of `\n`, which makes JSON.parse
   * reject the payload even when it is otherwise complete and balanced.
   */
  private escapeControlCharsInStrings(text: string): string {
    let out = "";
    let inString = false;
    let pendingBackslash = false;
    // The only characters JSON allows directly after a backslash. Anything else - most
    // commonly a Windows path like "C:\projekte\..." emitted with un-escaped backslashes -
    // is invalid JSON that jsonrepair's own invalid-escape recovery silently DROPS (backslash
    // and all), corrupting the value instead of failing loudly. Doubling the backslash here
    // turns it into a valid `\\x` escape that decodes back to a literal backslash + x, so the
    // path (or any other backslash-heavy value) survives intact.
    const validEscapeChars = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

    for (let i = 0; i < text.length; i++) {
      const char = text[i] ?? "";

      if (inString) {
        if (pendingBackslash) {
          pendingBackslash = false;
          out += validEscapeChars.has(char) ? `\\${char}` : `\\\\${char}`;
          continue;
        }
        if (char === "\\") {
          pendingBackslash = true;
          continue;
        }
        if (char === '"') {
          out += char;
          inString = false;
          continue;
        }
        if (char === "\n") { out += "\\n"; continue; }
        if (char === "\r") { out += "\\r"; continue; }
        if (char === "\t") { out += "\\t"; continue; }
        out += char;
        continue;
      }

      if (char === '"') {
        inString = true;
      }
      out += char;
    }

    // A lone trailing backslash (truncated mid-escape) - preserve it literally rather than
    // dropping it silently.
    if (pendingBackslash) out += "\\\\";

    return out;
  }

  /**
   * Strip residual LLM special tokens from the final response so raw markup
   * is never shown to the user (e.g. Hermes <|tool_call|> fragments, im_start/end, etc.)
   */
  private sanitizeFinalResponse(text: string): string {
    return text
      // Remove any <|...|> special tokens (Hermes / ChatML markers)
      .replace(/<\|[^|>]*\|>/g, "")
      // Remove orphan XML-style tool-call tags
      .replace(/<\/?tool_calls?[^>]*>/gi, "")
      .replace(/<\/?tool_call[^>]*>/gi, "")
      // Remove leading/trailing whitespace that may remain
      .trim();
  }

  /**
   * True when a response carries no readable content even though it is not
   * literally the empty string. Small local models (e.g. gemma-4) sometimes
   * answer with a lone markdown separator like "---", "***" or "___", or with
   * nothing but punctuation/whitespace. Those pass a naive `.trim().length > 0`
   * check yet render as an empty bubble in the UI, so the run appears to hang.
   * Treating them as blank lets the fallback generator produce a real message.
   */
  /**
   * Per-pass timeout for the post-response quality passes (reflection, verify,
   * post-iteration). These run AFTER the visible answer is streamed but BEFORE
   * run() resolves and the frontend receives chat:complete. A single local-model
   * call that stalls (LM Studio occasionally does) would otherwise freeze the
   * whole turn until the global no-progress timeout (minutes). Bounding each pass
   * lets a stalled call be abandoned so the turn still completes promptly.
   */
  private static readonly QUALITY_PASS_TIMEOUT_MS = 45000;

  /**
   * Resolve `promise`, or reject with a labelled timeout error after `ms`.
   * The underlying promise keeps running but its result is ignored on timeout.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let handle: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(handle)) as Promise<T>;
  }

  private isBlankResponse(text: string): boolean {
    const sanitized = this.sanitizeFinalResponse(text);
    if (sanitized.length === 0) return true;
    // Only markdown horizontal-rule characters / punctuation / whitespace left.
    return /^[-*_=~`.\s]+$/.test(sanitized);
  }

  private truncateText(value: string, maxChars: number): string {
    if (maxChars <= 0) return "";
    if (value.length <= maxChars) return value;
    const suffix = "\n...[truncated]";
    const keep = Math.max(0, maxChars - suffix.length);
    return `${value.slice(0, keep)}${suffix}`;
  }

  /**
   * Picks the terms a memory lookup should search for.
   *
   * The previous version took `tokens.slice(0, 3)` - the first three long words of each
   * signal, whatever they happened to be. For "Kannst du die Suche im Wiki verbessern"
   * that yields "kannst, suche" and drops "wiki" entirely: the sentence's opening words
   * are exactly the ones that carry the least meaning. Now stopwords are removed and the
   * remaining terms are ranked by how often they recur across the signals, so a term that
   * shows up in both the user input and the active skills outranks an incidental one.
   */
  private extractMemoryKeywords(signals: string[]): string[] {
    const frequency = new Map<string, number>();

    for (const signal of signals) {
      if (!signal || typeof signal !== "string") continue;
      for (const token of new Set(tokenizeText(signal))) {
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
      }
    }

    return Array.from(frequency.entries())
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .slice(0, 8)
      .map(([token]) => token);
  }

  private shouldUseLightweightMode(userInput: string, hasRecentSkillUsage: boolean): boolean {
    return !userInput.trim().startsWith("/")
      && userInput.length < 150
      && !hasRecentSkillUsage;
  }

  private async compressMessage(message: LLMMessage): Promise<LLMMessage> {
    if (typeof message.content !== "string" || message.content.length < 1500) {
      return message;
    }
    try {
      const summaryResult = await this.provider.generate([
        {
          role: "system",
          content: "Compress the following message into 1-2 sentences, preserving key information.",
        },
        {
          role: "user",
          content: message.content,
        },
      ]);
      return {
        ...message,
        content: summaryResult.content,
        metadata: {
          ...(typeof message.metadata === "object" ? message.metadata : {}),
          compressed: true,
          originalLength: message.content.length,
        },
      };
    } catch (error) {
      this.logger.warn("Message compression failed, using original", {
        error: error instanceof Error ? error.message : String(error),
        messageLength: message.content.length,
      });
      return message;
    }
  }

  private buildCompressedConversationWindow(
    maxMessages: number,
    maxChars: number,
    useCompression: boolean
  ): LLMMessage[] {
    const allMessages = this.conversation.getMessages();
    if (allMessages.length === 0) return [];

    const selected: LLMMessage[] = [];
    let usedChars = 0;

    for (let index = Math.max(0, allMessages.length - maxMessages); index < allMessages.length; index++) {
      const message = allMessages[index];
      if (!message) continue;

      let content = typeof message.content === "string" ? message.content : "";
      if (useCompression && content.length > 1500) {
        content = content.substring(0, 800) + "\n...[message compressed]";
      } else {
        content = this.truncateText(content, Math.max(200, 2000));
      }

      const nextChars = usedChars + content.length;
      if (selected.length > 0 && nextChars > maxChars) break;

      selected.push({
        ...message,
        content,
      });
      usedChars = nextChars;
    }

    return selected;
  }

  private parseFrontmatter(content: string): {
    name?: string;
    description?: string;
    primarySkills?: string[];
    relatedSkills?: string[];
    fallbackSkills?: string[];
  } {
    if (!content.startsWith("---")) return {};
    const end = content.indexOf("\n---", 3);
    if (end < 0) return {};
    const block = content.slice(3, end).trim();
    const parseSkillList = (raw: string): string[] => {
      const parsed = raw
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((token) => token.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
        .filter((token) => token.length > 0 && /^[a-z0-9_-]+$/.test(token));
      return Array.from(new Set(parsed));
    };

    const result: {
      name?: string;
      description?: string;
      primarySkills?: string[];
      relatedSkills?: string[];
      fallbackSkills?: string[];
    } = {};
    for (const line of block.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key === "name") result.name = value;
      if (key === "description") result.description = value;
      if (key === "primary_skills") {
        result.primarySkills = parseSkillList(value);
      }
      if (key === "related_skills") {
        result.relatedSkills = parseSkillList(value);
      }
      if (key === "fallback_skills") {
        result.fallbackSkills = parseSkillList(value);
      }
    }
    return result;
  }

  private expandRelatedSkills(
    selected: SkillManifest[],
    installed: SkillManifest[],
    allowlist: Set<string>
  ): SkillManifest[] {
    const bySlug = new Map(installed.map((skill) => [skill.slug, skill]));
    const visited = new Set(selected.map((skill) => skill.slug));
    const queue = [...selected];
    const extras: SkillManifest[] = [];
    const maxExtras = 10;

    const enqueueByPriority = (slugs: string[]): number => {
      let added = 0;
      for (const candidateSlug of slugs) {
        if (visited.has(candidateSlug)) continue;
        const candidate = bySlug.get(candidateSlug);
        if (!candidate) continue;
        if (allowlist.size > 0 && !allowlist.has(candidate.slug)) continue;

        visited.add(candidate.slug);
        extras.push(candidate);
        queue.push(candidate);
        added++;
        if (extras.length >= maxExtras) break;
      }
      return added;
    };

    while (queue.length > 0 && extras.length < maxExtras) {
      const current = queue.shift();
      if (!current) continue;
      const addedPrimary = enqueueByPriority(current.primarySkills);
      if (extras.length >= maxExtras) break;

      const addedRelated = enqueueByPriority(current.relatedSkills);
      if (extras.length >= maxExtras) break;

      // Fallback skills are only considered when stronger relations are not available.
      if (addedPrimary === 0 && addedRelated === 0) {
        enqueueByPriority(current.fallbackSkills);
      }
    }

    return extras;
  }

  /**
   * Re-scans skills/plugin-skills on disk, but only re-parses SKILL.md content when a
   * SKILL.md/plugin.json actually changed (mtime/size) since the last call - see
   * skill-cache.ts. Editing a skill still takes effect on the very next turn (no
   * restart needed), it just skips the readFileSync+frontmatter-parse work when nothing
   * changed, since this runs on effectively every agent turn.
   */
  private loadSkillManifests(): SkillManifest[] {
    let pluginSkillDirs: string[] = [];
    try {
      pluginSkillDirs = listPluginSkillDirs();
    } catch {
      // plugin skill scan is best-effort; never block the built-in skills
    }
    const watchedFiles = [
      ...listSkillMdFiles(this.skillsRoot),
      ...pluginSkillDirs.map((dir) => join(dir, "SKILL.md")),
    ];
    return withManifestCache(`skills:${this.skillsRoot}`, watchedFiles, () =>
      this.loadSkillManifestsUncached(pluginSkillDirs)
    );
  }

  private loadSkillManifestsUncached(pluginSkillDirs: string[]): SkillManifest[] {
    if (!existsSync(this.skillsRoot)) return [];
    const dirs = readdirSync(this.skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const result: SkillManifest[] = [];

    for (const entry of dirs) {
      const slug = entry.name;
      const skillPath = join(this.skillsRoot, slug, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      const content = readFileSync(skillPath, "utf8");
      const fm = this.parseFrontmatter(content);
      result.push({
        slug,
        name: fm.name ?? slug,
        description: fm.description,
        path: skillPath,
        primarySkills: fm.primarySkills ?? [],
        relatedSkills: fm.relatedSkills ?? [],
        fallbackSkills: fm.fallbackSkills ?? [],
      });
    }

    // Merge skills provided by enabled plugins (plugins/<name>/skills/<skill>). This is how a
    // plugin extends the agent's behavior/UX without any frontend injection - its skills join
    // progressive disclosure like built-in ones.
    for (const skillDir of pluginSkillDirs) {
      const skillPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      const slug = basename(skillDir);
      if (result.some((s) => s.slug === slug)) continue; // built-in wins on slug clash
      const fm = this.parseFrontmatter(readFileSync(skillPath, "utf8"));
      result.push({
        slug,
        name: fm.name ?? slug,
        description: fm.description,
        path: skillPath,
        primarySkills: fm.primarySkills ?? [],
        relatedSkills: fm.relatedSkills ?? [],
        fallbackSkills: fm.fallbackSkills ?? [],
      });
    }

    return result;
  }

  /** Re-read on every call (like loadSkillManifests) so editing a TOOL.md's `core` flag takes effect without a restart. */
  private getToolManifests(): ToolManifestEntry[] {
    return loadToolManifests();
  }

  private loadSkillContent(manifest: SkillManifest): SkillSummary {
    const content = readFileSync(manifest.path, "utf8");
    return {
      ...manifest,
      content,
    };
  }

  private tokenizeForMatching(value: string): string[] {
    return value
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
  }

  private scoreSkillMatch(input: string, skill: SkillManifest): number {
    // Calculate Jaccard similarity (token-based matching)
    const inputTokens = new Set(this.tokenizeForMatching(input));
    const skillTokens = new Set(this.tokenizeForMatching(`${skill.slug} ${skill.name} ${skill.description ?? ""}`));
    if (inputTokens.size === 0 || skillTokens.size === 0) return 0;

    let intersection = 0;
    for (const token of inputTokens) {
      if (skillTokens.has(token)) intersection++;
    }

    const union = new Set([...inputTokens, ...skillTokens]).size;
    const jaccardScore = union === 0 ? 0 : intersection / union;

    // Get semantic similarity from embeddings (P3.3)
    const semanticScore = skillSelector.calculateSemanticSimilarity(input, skill.slug);

    // Use SkillSelector's advanced scoring (P2.3)
    // Combines Jaccard, semantic similarity, and success rate
    let score = skillSelector.scoreSkill(input, skill, jaccardScore, semanticScore);

    // Preserve explicit keyword boosting for domain-specific skills
    const normalizedInput = input.toLowerCase();
    const boostAmount = 0.1; // Smaller boost since SkillSelector already scored

    if (
      skill.slug === "workflow-orchestrator" &&
      /(workflow|graph|editor|node|edge|orchestr|run|resume|pipeline)/.test(normalizedInput)
    ) {
      score = Math.min(1, score + boostAmount);
    }

    if (/(review|analyse|analyze|bug|risk|regression)/.test(normalizedInput) && skill.slug === "code-review") {
      score = Math.min(1, score + boostAmount);
    }

    if (/(test|tdd|red\s*green|spec)/.test(normalizedInput) && skill.slug === "test-driven-development") {
      score = Math.min(1, score + boostAmount);
    }

    if (/(plan|roadmap|milestone|strategie|strategy)/.test(normalizedInput) && skill.slug === "plan") {
      score = Math.min(1, score + boostAmount);
    }

    if (
      /(wiki|wissen|knowledge|dokumentation|docs|nachschlagen|recherche|quelle|sources|llm-wiki)/.test(normalizedInput) &&
      /(llm-wiki|knowledge-base|wiki)/.test(skill.slug)
    ) {
      score = Math.min(1, score + boostAmount);
    }

    if (
      this.isDateTimeIntent(input) &&
      /(datum-uhrzeit-tag|datum-uhrzeit|date-time)/.test(skill.slug)
    ) {
      score = Math.min(1, score + boostAmount);
    }

    return Math.min(1, score);
  }

  private isDateTimeIntent(input: string): boolean {
    const normalizedInput = input.toLowerCase();
    // "wieviel Uhr"/"wie spät" are at least as common as "Uhrzeit" in natural German but
    // don't contain that compound word, so they were previously invisible to this check.
    return /(welcher\s*tag|welchen\s*tag|wochentag|heute|datum|uhrzeit|wie\s*viel\s*uhr|wie\s*spät|date|time|day\s+is\s+it|what\s+day\s+is\s+it)/.test(normalizedInput);
  }

  private tokenOverlapCount(input: string, skill: SkillManifest): number {
    const inputTokens = new Set(this.tokenizeForMatching(input));
    const skillTokens = new Set(this.tokenizeForMatching(`${skill.slug} ${skill.name} ${skill.description ?? ""}`));
    let overlap = 0;
    for (const token of inputTokens) {
      if (skillTokens.has(token)) overlap++;
    }
    return overlap;
  }

  private rankSkillMatches(input: string, installed: SkillManifest[], alreadySelectedSlugs: Set<string>): SkillScore[] {
    return installed
      .filter((skill) => !alreadySelectedSlugs.has(skill.slug))
      .map((skill) => ({
        skill,
        score: this.scoreSkillMatch(input, skill),
        overlap: this.tokenOverlapCount(input, skill),
      }))
      .sort((a, b) => b.score - a.score);
  }

  private selectAutoSkill(
    input: string,
    installed: SkillManifest[],
    alreadySelectedSlugs: Set<string>,
    controls: AgentRuntimeControls
  ): { selected?: SkillManifest; scored: SkillScore[]; reason: string } {
    if (!controls.enableAutoSkillSelection) return { scored: [], reason: "disabled" };
    if (input.trim().length < controls.autoSkillMinInputLength) return { scored: [], reason: "input_too_short" };

    const scored = this.rankSkillMatches(input, installed, alreadySelectedSlugs);
    const best = scored[0];
    const second = scored[1];

    if (!best) return { scored, reason: "no_candidates" };
    if (best.score < controls.autoSkillScoreThreshold) return { scored, reason: "below_threshold" };
    if (best.overlap < controls.autoSkillMinOverlap) return { scored, reason: "overlap_too_low" };
    if (second && best.score - second.score < controls.autoSkillMarginThreshold) {
      return { scored, reason: "ambiguous_top_match" };
    }

    return { selected: best.skill, scored, reason: "selected" };
  }

  private extractRequestedSkillSlugs(text: string): { slugs: string[]; stripped: string } {
    const tokens = text.trimStart().split(/\s+/);
    const slugs: string[] = [];
    let idx = 0;
    while (idx < tokens.length) {
      const token = tokens[idx] ?? "";
      if (!token.startsWith("/")) break;
      const slug = token.slice(1).toLowerCase().trim();
      if (!slug || !/^[a-z0-9_-]+$/.test(slug)) break;
      slugs.push(slug);
      idx++;
      if (slugs.length >= 5) break;
    }

    if (slugs.length === 0) return { slugs: [], stripped: text };
    const stripped = tokens.slice(idx).join(" ").trim();
    return { slugs, stripped: stripped.length > 0 ? stripped : text };
  }

  private resolveToolNameAndInput(
    toolName: string,
    input: Record<string, unknown>
  ): { toolName: string; input: Record<string, unknown> } {
    const normalized = toolName.trim().toLowerCase();
    const normalizedInput: Record<string, unknown> = {
      ...input,
    };

    // Unified parameter aliasing: map old names to canonical names
    const PARAM_ALIASES: ReadonlyArray<readonly [from: string, to: string]> = [
      ["project_id", "projectId"],
      ["workflow_id", "id"],
      ["file_path", "path"],
      ["filepath", "path"],
      ["filename", "path"],
      ["old_string", "oldString"],
      ["old_str", "oldString"],
      ["oldStr", "oldString"],
      ["old_text", "oldString"],
      ["oldText", "oldString"],
      ["new_string", "newString"],
      ["new_str", "newString"],
      ["newStr", "newString"],
      ["new_text", "newString"],
      ["newText", "newString"],
      ["replace_all", "replaceAll"],
      ["base_path", "basePath"],
      ["dry_run", "dryRun"],
    ];

    for (const [from, to] of PARAM_ALIASES) {
      if (normalizedInput[from] !== undefined) {
        // Copy to the canonical key only when it isn't already set (canonical wins), then
        // drop the alias key so tools never receive both old_string AND oldString.
        if (normalizedInput[to] === undefined) {
          normalizedInput[to] = normalizedInput[from];
        }
        delete normalizedInput[from];
      }
    }

    const aliasToolName = this.toolRegistry.resolveAlias(normalized);
    const aliasAction = resolveToolAction(aliasToolName, normalized);

    if (aliasToolName === "filesystem" && aliasAction) {
      return {
        toolName: "filesystem",
        input: {
          ...normalizedInput,
          action: aliasAction,
          path: normalizedInput["path"] ?? normalizedInput["file_path"],
        },
      };
    }

    if (normalizedInput["command"] !== undefined && normalizedInput["action"] === undefined && normalized === "skill_manage") {
      normalizedInput["action"] = normalizedInput["command"];
    }

    const filesystemAliases = new Set(["read", "write", "append", "edit", "delete", "list", "mkdir", "exists", "stat", "move", "copy"]);

    if (filesystemAliases.has(normalized)) {
      const path = normalizedInput["path"] ?? normalizedInput["file_path"];
      return {
        toolName: "filesystem",
        input: {
          ...normalizedInput,
          action: normalized,
          path,
        },
      };
    }

    if (normalized === "http_get") {
      return {
        toolName: "http",
        input: {
          ...normalizedInput,
          action: "get",
        },
      };
    }

    if (normalized === "http_post" || normalized === "http_put" || normalized === "http_patch" || normalized === "http_delete") {
      const actionAliases: Record<string, string> = {
        http_post: "post",
        http_put: "put",
        http_patch: "patch",
        http_delete: "delete",
      };
      return {
        toolName: "http",
        input: {
          ...normalizedInput,
          action: actionAliases[normalized],
        },
      };
    }

    if (normalized === "bash" || normalized === "sh" || normalized === "zsh" || normalized === "pwsh" || normalized === "powershell" || normalized === "ps") {
      return {
        toolName: "shell",
        input: normalizedInput,
      };
    }

    if (normalized === "skill" || normalized === "skills") {
      if (normalizedInput["command"] !== undefined && normalizedInput["action"] === undefined) {
        normalizedInput["action"] = normalizedInput["command"];
      }
      return {
        toolName: "skill_manage",
        input: normalizedInput,
      };
    }

    if (normalized === "chat_history" || normalized === "conversation_history" || normalized === "history_search" || normalized === "chat-history" || normalized === "conversation-history") {
      return {
        toolName: "history",
        input: normalizedInput,
      };
    }

    if (normalized === "project") {
      if (normalizedInput["name"] === undefined) {
        const nameAlias = normalizedInput["project_name"] ?? normalizedInput["projectName"] ?? normalizedInput["title"];
        if (nameAlias !== undefined) {
          normalizedInput["name"] = nameAlias;
        }
      }

      // The project tool's own id field is "id", not "projectId" - but "projectId" is the
      // name an LLM naturally reaches for (it's what the "task" tool uses to reference a
      // parent project), so without this fallback project({action:"get", projectId:5})
      // silently fails with "id is required".
      if (normalizedInput["id"] === undefined && normalizedInput["projectId"] !== undefined) {
        normalizedInput["id"] = normalizedInput["projectId"];
      }

      if (normalizedInput["action"] !== undefined) {
        normalizedInput["action"] = resolveCanonicalAction("project", normalizedInput["action"]);
      } else {
        const hasUpdateFields = normalizedInput["name"] !== undefined
          || normalizedInput["description"] !== undefined
          || normalizedInput["folder"] !== undefined;
        if (normalizedInput["id"] !== undefined && hasUpdateFields) {
          // id + a mutable field with no explicit action reads as "update" - checking id
          // presence first (as this used to) silently dropped the update and just
          // returned the unchanged project instead.
          normalizedInput["action"] = "update";
        } else if (normalizedInput["id"] !== undefined) {
          normalizedInput["action"] = "get";
        } else if (normalizedInput["name"] !== undefined) {
          normalizedInput["action"] = "create";
        } else {
          normalizedInput["action"] = "list";
        }
      }
    }

    if (normalized === "task" && normalizedInput["action"] === undefined) {
      const hasUpdateSignalFields = normalizedInput["status"] !== undefined ||
        normalizedInput["priority"] !== undefined ||
        normalizedInput["result"] !== undefined ||
        normalizedInput["projectId"] !== undefined ||
        normalizedInput["project_id"] !== undefined ||
        normalizedInput["subtasks"] !== undefined;
      const hasMutableFields = hasUpdateSignalFields
        || normalizedInput["title"] !== undefined
        || normalizedInput["description"] !== undefined;

      if (normalizedInput["id"] !== undefined && hasMutableFields) {
        // id + any mutable field with no explicit action reads as "update" - checking id
        // presence first (as this used to) silently dropped the change and just
        // returned the task unchanged instead.
        normalizedInput["action"] = "update";
      } else if (normalizedInput["id"] !== undefined) {
        normalizedInput["action"] = "get";
      } else if (normalizedInput["title"] !== undefined || normalizedInput["description"] !== undefined) {
        normalizedInput["action"] = "create";
      } else if (hasUpdateSignalFields) {
        normalizedInput["action"] = "update";
      } else {
        normalizedInput["action"] = "list";
      }
    }

    if (normalized === "task" && normalizedInput["action"] !== undefined) {
      normalizedInput["action"] = resolveCanonicalAction("task", normalizedInput["action"]);

      const normalizedAction = String(normalizedInput["action"] ?? "").toLowerCase();
      if (normalizedAction === "get") {
        const status = String(normalizedInput["status"] ?? "").toLowerCase();
        const hasUpdateFields = ["status", "priority", "result", "subtasks", "title", "description", "projectId", "project_id"].some(
          (key) => normalizedInput[key] !== undefined
        );
        if (hasUpdateFields) {
          if (status === "completed") {
            normalizedInput["action"] = "complete";
          } else if (status === "failed") {
            normalizedInput["action"] = "fail";
          } else if (status === "running") {
            normalizedInput["action"] = "start";
          } else {
            normalizedInput["action"] = "update";
          }
        }
      }

      const legacyTaskId = String(normalizedInput["id"] ?? "").trim().match(/^task_(\d+)$/i);
      if (legacyTaskId?.[1]) {
        normalizedInput["id"] = Number(legacyTaskId[1]);
      }
    }

    if (normalized === "workflow" && normalizedInput["action"] === undefined) {
      if (normalizedInput["id"] !== undefined) {
        normalizedInput["action"] = "get";
      } else if (normalizedInput["name"] !== undefined) {
        normalizedInput["action"] = "create";
      } else {
        normalizedInput["action"] = "list";
      }
    }

    if (normalized === "gateway") {
      // Field-name aliasing: models routinely call this tool with natural field names
      // instead of its exact schema — most notably "content" (Discord's OWN API field),
      // plus "text"/"body" for the message and "channel"/"to"/"target" for the destination.
      // Without this, a perfectly-intended send fails as "missing message/target". Map the
      // common variants onto the canonical fields BEFORE action inference below.
      const g = normalizedInput;
      const firstFilled = (...keys: string[]): unknown =>
        keys.map((k) => g[k]).find((v) => v !== undefined && v !== null && String(v).trim() !== "");
      if (g["message"] === undefined || String(g["message"] ?? "").trim() === "") {
        const m = firstFilled("content", "text", "body", "msg", "messageContent");
        if (m !== undefined) g["message"] = m;
      }
      if (
        (g["channelId"] === undefined || String(g["channelId"] ?? "").trim() === "") &&
        (g["externalConversationId"] === undefined || String(g["externalConversationId"] ?? "").trim() === "")
      ) {
        const c = firstFilled("channel", "channelName", "channel_id", "to", "target", "recipient", "chatId", "chat_id");
        if (c !== undefined) g["channelId"] = c;
      }
      if (g["portal"] === undefined || String(g["portal"] ?? "").trim() === "") {
        const p = firstFilled("platform", "service", "provider");
        if (p !== undefined) g["portal"] = p;
      }
    }

    if (normalized === "gateway" && normalizedInput["action"] === undefined) {
      if (normalizedInput["message"] !== undefined) {
        normalizedInput["action"] = "send";
      } else {
        normalizedInput["action"] = "list_configs";
      }
    }

    if (normalized === "plan" && normalizedInput["action"] === undefined) {
      normalizedInput["action"] = normalizedInput["feedback"] !== undefined ? "refine" : "create";
    }

    // A model that sees a skill's slug in its "Loaded Skills" context (e.g. datum-uhrzeit-tag)
    // routinely calls it as if it were a tool - [TOOL:datum-uhrzeit-tag()] - instead of the
    // documented skill_manage(action:"execute", name:...) wrapper. Without this, that call
    // resolves to no real tool, silently produces no result, and the run ends with a generic
    // "no answer" fallback despite having picked the right skill.
    // Guarded against real tool names ("plan" and "memory" exist as both a tool and a skill
    // slug) so this never hijacks a genuine tool call for one of those.
    if (
      this.activeSkillSlugsForRun.has(normalized) &&
      !this.executor.listTools().some((tool) => tool.name === normalized)
    ) {
      return {
        toolName: "skill_manage",
        input: { action: "execute", name: normalized, input: normalizedInput },
      };
    }

    // Generic tool-name alias resolution (e.g. browser_control -> browser, task_split -> task)
    // applied at EXTRACTION time so batch execution never receives an unknown tool name. The
    // per-tool action is canonicalized too (e.g. browser navigate -> goto), which the earlier
    // tool-specific branches only did for project/task. Only names that are NOT already a real
    // registered tool are alias-resolved, so a genuine tool call is never remapped.
    const isRealTool = this.executor.listTools().some((tool) => tool.name === normalized);
    const targetTool = isRealTool ? normalized : resolveToolAlias(normalized);

    if (typeof normalizedInput["action"] === "string" && TOOL_ACTION_ALIAS_MAP[targetTool]) {
      normalizedInput["action"] = resolveCanonicalAction(targetTool, normalizedInput["action"]);
    }

    return { toolName: targetTool, input: normalizedInput };
  }

  private async preflightToolInput(
    toolName: string,
    input: Record<string, unknown>,
    controls: AgentRuntimeControls
  ): Promise<{ ok: true; input: Record<string, unknown> } | { ok: false; error: string }> {
    // Resolve tool aliases FIRST (e.g., "task_split" -> "task")
    const resolvedToolName = resolveToolAlias(toolName);
    const normalizedName = resolvedToolName.trim().toLowerCase();
    let normalizedInput: Record<string, unknown> = { ...input };

    // Phase 2: Apply input normalization pipeline
    const normResult = await this.inputNormalizer.normalize(normalizedName, normalizedInput);
    if (normResult.transformations.length > 0) {
      normalizedInput = normResult.normalized;
      this.logger.debug("Input normalized", {
        toolName: normalizedName,
        transformations: normResult.transformations.map((t) => `${t.field}: ${t.via}`),
      });
    }
    if (normResult.warnings.length > 0) {
      this.logger.warn("Input normalization warnings", { toolName: normalizedName, warnings: normResult.warnings });
    }

    if (normalizedName === "shell" && normalizedInput["timeout"] === undefined) {
      normalizedInput["timeout"] = controls.shellToolTimeoutMs;
    }
    if (normalizedName === "http" && normalizedInput["timeout"] === undefined) {
      normalizedInput["timeout"] = controls.httpToolTimeoutMs;
    }
    if (normalizedName === "git" && normalizedInput["timeout"] === undefined) {
      normalizedInput["timeout"] = controls.gitToolTimeoutMs;
    }
    if (normalizedName === "browser") {
      if (normalizedInput["timeout"] === undefined) {
        normalizedInput["timeout"] = controls.browserToolTimeoutMs;
      }
      if (normalizedInput["timeoutMs"] === undefined) {
        normalizedInput["timeoutMs"] = controls.browserToolTimeoutMs;
      }

      const browserAction = String(normalizedInput["action"] ?? "").trim().toLowerCase();
      // screenshot_url and stream_start can ALSO launch (or reuse) a session, via the same
      // resolveOrLaunchSession() path as "launch" itself - without these settings injected
      // here too, a macro call that ends up creating a fresh browser would silently ignore
      // BROWSER_HEADLESS_MODE and the other launch-time settings that "launch" honors.
      if (browserAction === "launch" || browserAction === "screenshot_url" || browserAction === "stream_start") {
        if (normalizedInput["newSession"] === undefined) {
          normalizedInput["newSession"] = !controls.browserReuseSession;
        }
        if (normalizedInput["headless"] === undefined) {
          normalizedInput["headless"] = controls.browserHeadless;
        }
        if (normalizedInput["viewport"] === undefined) {
          normalizedInput["viewport"] = { width: controls.browserViewportWidth, height: controls.browserViewportHeight };
        }
        if (normalizedInput["executablePath"] === undefined && controls.browserExecutablePath) {
          normalizedInput["executablePath"] = controls.browserExecutablePath;
        }
        if (normalizedInput["userAgent"] === undefined && controls.browserUserAgent) {
          normalizedInput["userAgent"] = controls.browserUserAgent;
        }
        if (normalizedInput["disableImages"] === undefined) {
          normalizedInput["disableImages"] = controls.browserDisableImages;
        }
        if (normalizedInput["blockResources"] === undefined) {
          normalizedInput["blockResources"] = controls.browserBlockResources;
        }
        if (normalizedInput["hideAutomation"] === undefined) {
          normalizedInput["hideAutomation"] = controls.browserHideAutomation;
        }
        if (normalizedInput["cookieDetection"] === undefined) {
          normalizedInput["cookieDetection"] = controls.browserCookieDetection;
        }
        if (normalizedInput["proxyUrl"] === undefined && controls.browserProxyUrl) {
          normalizedInput["proxyUrl"] = controls.browserProxyUrl;
        }
      }
      if (browserAction === "screenshot") {
        if (normalizedInput["screenshotFormat"] === undefined) {
          normalizedInput["screenshotFormat"] = controls.browserScreenshotFormat;
        }
        if (normalizedInput["screenshotQuality"] === undefined) {
          normalizedInput["screenshotQuality"] = controls.browserScreenshotQuality;
        }
      }
    }

    if (!(await this.executor.hasTool(normalizedName))) {
      return { ok: false, error: `Unknown tool '${normalizedName}'` };
    }

    if (!isToolActive(normalizedName, this.getToolManifests(), new Set(controls.enabledOptionalTools))) {
      return { ok: false, error: `Tool '${normalizedName}' is disabled. Enable it in Settings -> Tools.` };
    }

    if (normalizedName === "http" && normalizedInput["action"] === undefined && normalizedInput["url"] !== undefined) {
      normalizedInput["action"] = "get";
    }

    if (normalizedName === "filesystem") {
      const action = String(normalizedInput["action"] ?? "").toLowerCase();
      const path = normalizedInput["path"];
      if (!action) return { ok: false, error: "filesystem: 'action' parameter required. Valid actions: read, write, append, edit, delete, list, mkdir, exists, stat, move, copy" };
      if (!path || String(path).trim().length === 0) {
        return { ok: false, error: "filesystem: 'path' parameter is REQUIRED and must not be empty. Provide the file or directory path you want to operate on. Example: filesystem({action:'read', path:'data/file.txt'})" };
      }
      if (action === "write" || action === "append") {
        // Resolve the body with the SAME rule the tool itself uses - field aliases included.
        // These two checks used to disagree: the tool accepted nine alias names, the preflight
        // demanded a literal string in `content`, so a write emitted as `file_text` (Anthropic's
        // own text-editor convention) was rejected before the tool could ever have handled it.
        // The model, told to "pass content as a string", re-sent the same call - which is how a
        // writable file turned into ten identical failures and a killed run.
        const resolvedContent = extractFileContent(normalizedInput, String(path));
        if (resolvedContent === undefined) {
          return {
            ok: false,
            error:
              `filesystem:${action} needs the file body. Pass it as a plain string in 'content' ` +
              `in this SAME call - not in a separate message, and not as a description of the file.`,
          };
        }
        // An empty body is refused HERE rather than at the tool, so the self-repair pass gets a
        // chance to re-issue the write with the full content. Its overwhelmingly common cause is
        // a call cut off mid-content, which the JSON repair pass closes into `content: ""` - see
        // EMPTY_CONTENT_ERROR. Writing it would silently produce a 0-byte file and report success.
        if (resolvedContent === "" && !isIntentionalEmptyWrite(normalizedInput)) {
          return { ok: false, error: EMPTY_CONTENT_ERROR };
        }
        // Normalise onto `content` so downstream (tool, hooks, logging) sees one canonical shape.
        normalizedInput["content"] = resolvedContent;
      }
      if (action === "edit") {
        if (typeof normalizedInput["oldString"] !== "string" || String(normalizedInput["oldString"]).trim().length === 0) {
          return { ok: false, error: "filesystem:edit requires non-empty string field 'oldString' (the exact existing text to replace). Also provide 'newString'." };
        }
        if (typeof normalizedInput["newString"] !== "string") {
          return { ok: false, error: "filesystem:edit requires string field 'newString' (use \"\" to delete the matched text)." };
        }
      }
      if (action === "move" && String(normalizedInput["destination"] ?? "").trim().length === 0) {
        return { ok: false, error: "filesystem:move requires field 'destination'" };
      }
      if (normalizedInput["basePath"] !== undefined && String(normalizedInput["basePath"]).trim().length === 0) {
        return { ok: false, error: "filesystem: basePath must not be empty when provided" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "http") {
      const action = String(normalizedInput["action"] ?? "").toLowerCase();
      if (!action) return { ok: false, error: "http: action is required" };
      const url = String(normalizedInput["url"] ?? "").trim();
      const baseUrl = String(normalizedInput["baseUrl"] ?? "").trim();
      const path = String(normalizedInput["path"] ?? "").trim();
      if (!url && !(baseUrl && path)) {
        return { ok: false, error: "http: provide 'url' or both 'baseUrl' and 'path'" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "shell") {
      const command = normalizedInput["command"];
      if (!command || String(command).trim().length === 0) {
        return { ok: false, error: "shell: command is required" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "project") {
      const action = String(normalizedInput["action"] ?? "").toLowerCase();
      if (!action) return { ok: false, error: "project: action is required" };
      if ((action === "get" || action === "update" || action === "delete") && !Number.isFinite(Number(normalizedInput["id"]))) {
        return { ok: false, error: `project:${action} requires numeric field 'id'` };
      }
      if (action === "create" && String(normalizedInput["name"] ?? "").trim().length === 0) {
        return { ok: false, error: "project:create requires field 'name'" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "task") {
      const action = String(normalizedInput["action"] ?? "").toLowerCase();
      const legacyTaskId = String(normalizedInput["id"] ?? "").trim().match(/^task_(\d+)$/i);
      if (legacyTaskId?.[1]) {
        normalizedInput["id"] = Number(legacyTaskId[1]);
      }
      if (!action) return { ok: false, error: "task: action is required" };
      if (["get", "update", "start", "complete", "fail", "delete"].includes(action)) {
        if (!Number.isFinite(Number(normalizedInput["id"]))) {
          return { ok: false, error: `task:${action} requires numeric field 'id'` };
        }
      }
      if (action === "create" && String(normalizedInput["title"] ?? "").trim().length === 0) {
        return { ok: false, error: "task:create requires field 'title'" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "skill_manage") {
      const rawAction = String(normalizedInput["action"] ?? "").toLowerCase();
      const actionAliases: Record<string, string> = {
        edit_skill: "rename",
      };
      const action = actionAliases[rawAction] ?? rawAction;
      normalizedInput["action"] = action;
      if (normalizedInput["skillName"] !== undefined && normalizedInput["name"] === undefined) {
        normalizedInput["name"] = normalizedInput["skillName"];
      }
      if (normalizedInput["path"] !== undefined && normalizedInput["name"] === undefined) {
        const pathValue = String(normalizedInput["path"] ?? "").replaceAll("\\", "/");
        const pathMatch = pathValue.match(/(?:^|\/)skills\/([^/]+)\.md$/i);
        if (pathMatch?.[1]) {
          normalizedInput["name"] = pathMatch[1];
        }
      }
      if (normalizedInput["oldSkillName"] !== undefined && normalizedInput["old_name"] === undefined) {
        normalizedInput["old_name"] = normalizedInput["oldSkillName"];
      }
      if (normalizedInput["newSkillName"] !== undefined && normalizedInput["new_name"] === undefined) {
        normalizedInput["new_name"] = normalizedInput["newSkillName"];
      }
      if (!action) return { ok: false, error: "skill_manage: action is required" };
      if (["view", "create", "patch", "edit", "delete", "write_file", "remove_file"].includes(action)) {
        if (String(normalizedInput["name"] ?? "").trim().length === 0) {
          return { ok: false, error: `skill_manage:${action} requires field 'name'` };
        }
      }
      if (action === "rename") {
        if (String(normalizedInput["oldSkillName"] ?? normalizedInput["old_name"] ?? normalizedInput["name"] ?? "").trim().length === 0) {
          return { ok: false, error: "skill_manage:rename requires field 'oldSkillName'" };
        }
        if (String(normalizedInput["newSkillName"] ?? normalizedInput["new_name"] ?? "").trim().length === 0) {
          return { ok: false, error: "skill_manage:rename requires field 'newSkillName'" };
        }
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "memory") {
      const rawAction = String(normalizedInput["action"] ?? "").toLowerCase();
      const actionAliases: Record<string, string> = {
        add_memory: "add",
        query_memories: "query",
        list_memories: "list",
      };
      const action = actionAliases[rawAction] ?? rawAction;
      normalizedInput["action"] = action;
      if (!action) return { ok: false, error: "memory: action is required" };
      if (!["query", "add", "replace", "remove", "list", "batch", "pending_list", "approve"].includes(action)) {
        return { ok: false, error: `memory: unknown action '${action}'` };
      }
      if (action === "query" && String(normalizedInput["query"] ?? "").trim().length === 0) {
        return { ok: false, error: "memory:query requires field 'query'" };
      }
      if (action === "add" && String(normalizedInput["content"] ?? "").trim().length === 0) {
        return { ok: false, error: "memory:add requires field 'content'" };
      }
      if (["replace", "remove"].includes(action) && String(normalizedInput["oldText"] ?? "").trim().length === 0) {
        return { ok: false, error: `memory:${action} requires field 'oldText'` };
      }
      if (action === "replace" && String(normalizedInput["content"] ?? "").trim().length === 0) {
        return { ok: false, error: "memory:replace requires field 'content'" };
      }
      if (action === "batch") {
        if (!Array.isArray(normalizedInput["operations"]) || (normalizedInput["operations"] as unknown[]).length === 0) {
          return { ok: false, error: "memory:batch requires non-empty field 'operations'" };
        }
      }
      if (action === "approve" && String(normalizedInput["pendingId"] ?? "").trim().length === 0) {
        return { ok: false, error: "memory:approve requires field 'pendingId'" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "workflow") {
      const rawAction = String(normalizedInput["action"] ?? "").toLowerCase();
      const actionAliases: Record<string, string> = {
        create_graph: "create",
      };
      const action = actionAliases[rawAction] ?? rawAction;
      normalizedInput["action"] = action;
      if (!action) return { ok: false, error: "workflow: action is required" };
      if (!["list", "get", "create", "update", "run", "resume", "delete"].includes(action)) {
        return { ok: false, error: `workflow: unknown action '${action}'` };
      }
      if (["get", "update", "run", "resume", "delete"].includes(action)) {
        if (String(normalizedInput["id"] ?? "").trim().length === 0) {
          return { ok: false, error: `workflow:${action} requires field 'id'` };
        }
      }
      if (action === "create" && String(normalizedInput["name"] ?? "").trim().length === 0) {
        return { ok: false, error: "workflow:create requires field 'name'" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "plan") {
      const action = String(normalizedInput["action"] ?? "create").toLowerCase() === "refine" ? "refine" : "create";
      normalizedInput["action"] = action;
      if (action === "create" && String(normalizedInput["goal"] ?? "").trim().length === 0) {
        return { ok: false, error: "plan:create requires field 'goal'" };
      }
      if (action === "refine") {
        if (!normalizedInput["plan"] || typeof normalizedInput["plan"] !== "object") {
          return { ok: false, error: "plan:refine requires field 'plan' (the existing plan object returned by plan:create)" };
        }
        if (String(normalizedInput["feedback"] ?? "").trim().length === 0) {
          return { ok: false, error: "plan:refine requires field 'feedback'" };
        }
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "history") {
      const action = String(normalizedInput["action"] ?? "").toLowerCase();
      if (!action) return { ok: false, error: "history: action is required" };
      if (!["search", "list_conversations", "get_messages", "get_conversation"].includes(action)) {
        return { ok: false, error: `history: unknown action '${action}'` };
      }
      if (["get_messages", "get_conversation"].includes(action) && !Number.isFinite(Number(normalizedInput["conversationId"]))) {
        return { ok: false, error: `history:${action} requires numeric field 'conversationId'` };
      }
      if (action === "search" && String(normalizedInput["query"] ?? "").trim().length === 0) {
        return { ok: false, error: "history:search requires field 'query'" };
      }
      return { ok: true, input: normalizedInput };
    }

    if (normalizedName === "gateway") {
      const action = String(normalizedInput["action"] ?? "").toLowerCase();
      if (!action) return { ok: false, error: "gateway: action is required" };
      if (!["list_configs", "send"].includes(action)) {
        return { ok: false, error: `gateway: unknown action '${action}'` };
      }
      if (action === "send" && String(normalizedInput["message"] ?? "").trim().length === 0) {
        return { ok: false, error: "gateway:send requires field 'message'" };
      }
      return { ok: true, input: normalizedInput };
    }

    return { ok: true, input: normalizedInput };
  }

  private parseHermesArgs(rawArgs: string): Record<string, unknown> | undefined {
    const source = rawArgs.trim();
    if (!source) return {};

    const out: Record<string, unknown> = {};
    let i = 0;

    const decodeTokenQuotes = (value: string): string =>
      value.replaceAll('<|"|>', '"').replaceAll("<|'|>", "'");

    const skipWs = () => {
      while (i < source.length && /\s/.test(source[i] ?? "")) i++;
    };

    const peekChar = (): string | undefined => source[i];

    const readKey = (): string | undefined => {
      skipWs();
      const start = i;
      // Support both quoted and unquoted keys
      if ((source[i] ?? "") === '"') {
        i++; // skip opening quote
        while (i < source.length && source[i] !== '"') {
          if (source[i] === "\\" && i + 1 < source.length) i++; // skip escape
          i++;
        }
        if (source[i] === '"') i++; // skip closing quote
        return source.slice(start + 1, i - 1);
      }

      // Unquoted key: alphanumeric, underscore, hyphen
      while (i < source.length && /[A-Za-z0-9_\-]/.test(source[i] ?? "")) i++;
      const key = source.slice(start, i).trim();
      return key.length > 0 ? key : undefined;
    };

    const readDelimitedValue = (delimiter: string): string | undefined => {
      if (!source.startsWith(delimiter, i)) return undefined;
      i += delimiter.length;

      let searchFrom = i;
      while (searchFrom < source.length) {
        const end = source.indexOf(delimiter, searchFrom);
        if (end < 0) return undefined;

        const remainder = source.slice(end + delimiter.length).trimStart();
        if (remainder.length === 0 || remainder.startsWith(",") || remainder.startsWith("}")) {
          const value = source.slice(i, end);
          i = end + delimiter.length;
          return decodeTokenQuotes(value);
        }

        searchFrom = end + delimiter.length;
      }

      return undefined;
    };

    const readValue = (): unknown => {
      skipWs();
      const ch = peekChar();

      // Try Hermes-encoded quotes first
      const hermesQuoted = readDelimitedValue('<|"|>');
      if (hermesQuoted !== undefined) return hermesQuoted;

      const singleHermesQuoted = readDelimitedValue("<|'|>");
      if (singleHermesQuoted !== undefined) return singleHermesQuoted;

      // Try regular double quotes
      if (ch === '"') {
        i++;
        let value = "";
        while (i < source.length) {
          const c = source[i] ?? "";
          if (c === '"') {
            i++;
            break;
          }
          if (c === "\\" && i + 1 < source.length) {
            // Translate JSON-style escapes to their real character - \", \', \\ keep the
            // literal next char (correct as-is), but \n \t \r were being handled the same
            // way, i.e. the backslash was just dropped and the bare letter "n"/"t"/"r" kept
            // literally instead of becoming an actual newline/tab/CR. That silently mangled
            // any multi-line content that fell through every other JSON.parse-based repair
            // attempt and only got salvaged by this last-resort hand-rolled parser.
            const next = source[i + 1] ?? "";
            value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
            i += 2;
            continue;
          }
          value += c;
          i++;
        }
        return decodeTokenQuotes(value);
      }

      // Try single quotes
      if (ch === "'") {
        i++;
        let value = "";
        while (i < source.length) {
          const c = source[i] ?? "";
          if (c === "'") {
            i++;
            break;
          }
          if (c === "\\" && i + 1 < source.length) {
            // Translate JSON-style escapes to their real character - \", \', \\ keep the
            // literal next char (correct as-is), but \n \t \r were being handled the same
            // way, i.e. the backslash was just dropped and the bare letter "n"/"t"/"r" kept
            // literally instead of becoming an actual newline/tab/CR. That silently mangled
            // any multi-line content that fell through every other JSON.parse-based repair
            // attempt and only got salvaged by this last-resort hand-rolled parser.
            const next = source[i + 1] ?? "";
            value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
            i += 2;
            continue;
          }
          value += c;
          i++;
        }
        return decodeTokenQuotes(value);
      }

      // Try boolean/null/number literals
      if (source.startsWith("true", i)) {
        i += 4;
        return true;
      }
      if (source.startsWith("false", i)) {
        i += 5;
        return false;
      }
      if (source.startsWith("null", i)) {
        i += 4;
        return null;
      }

      // Read unquoted value (number or bare string)
      const start = i;
      while (i < source.length && !/[,}]/.test(source[i] ?? "")) i++;
      const raw = source.slice(start, i).trim();

      if (raw.length === 0) return undefined;

      const asNum = Number(raw);
      if (!Number.isNaN(asNum) && /^-?\d+(\.\d+)?$/.test(raw)) return asNum;

      return decodeTokenQuotes(raw);
    };

    // Main parsing loop
    while (i < source.length) {
      skipWs();
      if (i >= source.length || peekChar() === "}") break;

      const key = readKey();
      if (!key) break;

      skipWs();
      const sep = peekChar();
      if (sep !== ":" && sep !== "=") break; // Allow both : and = as separators
      i++; // skip separator

      const value = readValue();
      out[key] = value;

      skipWs();
      if (peekChar() === ",") {
        i++;
      }
    }

    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** Check if braces/brackets/parens are balanced (not inside a string) in text.
   *  Used to decide if a newline in Hermes payload is truly a terminator or just prose.
   */
  private isBracketBalanced(text: string): boolean {
    let depth = 0;
    let inString = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const prevChar = i > 0 ? text[i - 1] : "";

      if (char === '"' && prevChar !== "\\") {
        inString = !inString;
      }

      if (!inString) {
        if (char === "{" || char === "[" || char === "(") depth++;
        if (char === "}" || char === "]" || char === ")") depth--;
      }
    }

    return depth === 0;
  }

  private extractHermesCall(response: string): { toolName: string; args: string } | undefined {
    // Support multiple Hermes/ChatML markers: <|tool_call>call:, <|tool_call>, or variations
    const markers = ["<|tool_call>call:", "<|tool_call>", "<|im_function>"];
    let start = -1;
    let marker = "";

    for (const m of markers) {
      const idx = response.indexOf(m);
      if (idx >= 0 && (start < 0 || idx < start)) {
        start = idx;
        marker = m;
      }
    }

    if (start < 0) return undefined;

    const afterStart = response.slice(start + marker.length);

    // Find explicit end markers first
    const explicitEnds = ["<|tool_call|>", "<|/tool_call|>", "<tool_call/>"];
    let end = -1;
    for (const m of explicitEnds) {
      const idx = afterStart.indexOf(m);
      if (idx >= 0 && (end < 0 || idx < end)) end = idx;
    }

    // If no explicit marker, use newline only if brackets are balanced
    // (else a `\n` inside a JSON string cuts the payload early)
    if (end < 0) {
      const newlineIdx = afterStart.indexOf("\n");
      if (newlineIdx >= 0) {
        const upToNewline = afterStart.slice(0, newlineIdx);
        if (this.isBracketBalanced(upToNewline)) {
          end = newlineIdx;
        } else {
          // Brackets unbalanced at first \n, keep going
          end = afterStart.length;
        }
      } else {
        end = afterStart.length;
      }
    }

    const callBody = afterStart.slice(0, end).trim();

    // Match: toolName({"json": "value"}) or toolName{...}
    const parenMatch = callBody.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*\(([\s\S]*?)\)\s*$/);
    if (parenMatch?.[1]) {
      const toolName = parenMatch[1].trim();
      const rawArgs = (parenMatch[2] ?? "").trim();
      const args = rawArgs.startsWith("{") && rawArgs.endsWith("}")
        ? rawArgs.slice(1, -1)
        : rawArgs;
      return { toolName, args };
    }

    // Match: toolName{"json": "value"}
    const braceMatch = callBody.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*(\{[\s\S]*\})\s*$/);
    if (braceMatch?.[1]) {
      const toolName = braceMatch[1].trim();
      const rawJson = braceMatch[2] ?? "{}";
      const args = rawJson.startsWith("{") && rawJson.endsWith("}")
        ? rawJson.slice(1, -1)
        : rawJson;
      return { toolName, args };
    }

    // Fallback: extract the tool name (leading identifier before "(" or "{") and everything
    // from the first "{" onward as args. Works even when the brackets NEVER close - a
    // truncated tool call (token limit) still yields the partial args, which the downstream
    // repair (closeUnbalancedBrackets/parseLooseObject) can then salvage. Without this a
    // cut-off call was silently dropped.
    const firstBrace = callBody.indexOf("{");
    if (firstBrace < 0) return undefined;

    const nameMatch = callBody.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*[({]/);
    const toolName = (nameMatch?.[1] ?? callBody.slice(0, firstBrace).trim()).trim();
    if (!toolName || !/^[A-Za-z_][A-Za-z0-9_\-]*$/.test(toolName)) return undefined;

    const lastBrace = callBody.lastIndexOf("}");
    const args = lastBrace > firstBrace
      ? callBody.slice(firstBrace + 1, lastBrace)
      : callBody.slice(firstBrace + 1); // unclosed -> take the rest of the string
    return { toolName, args };
  }

  /** Models frequently wrap the real arguments in a single {"json": {...}} or {"args": {...}}
   *  envelope. jsonrepair happily returns that wrapper as a valid object, so unwrap it here -
   *  a one-key object whose only key is "json"/"args" and whose value is an object is always
   *  the envelope mistake, never a genuine argument set. */
  private unwrapArgsWrapper(obj: Record<string, unknown>): Record<string, unknown> {
    const keys = Object.keys(obj);
    if (keys.length === 1 && (keys[0] === "json" || keys[0] === "args")) {
      const inner = obj[keys[0]];
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        return inner as Record<string, unknown>;
      }
    }
    return obj;
  }

  private parseLooseObject(text: string): Record<string, unknown> | undefined {
    const normalized = this.normalizeToolCallText(text);
    if (!normalized || normalized.trim().length === 0) return {};

    // Local models frequently emit raw newlines/tabs inside string values (e.g. a
    // write_file `content` with real line breaks instead of `\n`). Standard JSON.parse
    // rejects unescaped control characters inside a string literal, so escape them
    // before any parse attempt - otherwise a perfectly complete, well-formed-looking
    // payload still fails to parse and the whole tool call is silently dropped.
    const escaped = this.escapeControlCharsInStrings(normalized);
    const candidate = escaped.startsWith("{") ? escaped : `{${escaped}}`;

    // First attempt: Try parsing as-is (might already be valid JSON)
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return this.unwrapArgsWrapper(parsed as Record<string, unknown>);
      }
    } catch {
      // Will try fixes below
    }

    // Primary repair: the jsonrepair library is purpose-built for broken/partial
    // JSON from LLMs — missing brackets, wrong terminators, unescaped control chars,
    // single quotes, unquoted keys, truncation. It handles the bulk of malformed
    // tool calls; the hand-rolled fixes below remain as a backup for anything it
    // can't salvage. Runs on the pre-control-char-escaped text so it never has to
    // guess about raw newlines inside string values.
    try {
      const parsed = JSON.parse(jsonrepair(candidate));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.logger.debug("[PARSER] Repaired tool call JSON via jsonrepair");
        return this.unwrapArgsWrapper(parsed as Record<string, unknown>);
      }
    } catch {
      // jsonrepair couldn't salvage it — fall through to the hand-rolled fixes.
    }

    // Recover `func({...}, "key": val)` where args after the object are loose pairs
    // (jsonrepair turns that into an array, which we reject). Merge them into the
    // object, then parse (jsonrepair handles any remaining minor breakage).
    const mergedPairs = this.mergeTrailingPairsIntoObject(candidate);
    if (mergedPairs) {
      for (const attempt of [mergedPairs, () => jsonrepair(mergedPairs)]) {
        try {
          const text = typeof attempt === "function" ? attempt() : attempt;
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            this.logger.debug("[PARSER] Merged loose trailing pairs into tool call object");
            return parsed as Record<string, unknown>;
          }
        } catch {
          // Try the next form / fall through.
        }
      }
    }

    // Local models routinely truncate the JSON one character early - almost always the
    // final `}` right before the [TOOL:...] call's own closing `)]`, e.g.
    // {"command": "..."} emitted as {"command": "...". Close off exactly the brackets that
    // were actually left open before falling through to the looser fixes below - if that
    // still doesn't produce valid JSON (or the string itself was left unterminated, where
    // there's no safe way to guess where it was meant to end), this is a no-op.
    const repaired = this.closeUnbalancedBrackets(candidate);
    if (repaired !== candidate) {
      try {
        const parsed = JSON.parse(repaired);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Will try fixes below
      }
    }

    // Salvage a botched closing sequence. Local models (e.g. gemma) sometimes end
    // a write call with the wrong terminators — "]]" or ")]" instead of "})]" — so
    // the JSON object's own "}" is missing and a stray "]"/")" trails the last
    // string value. A JSON object can never legally end in "]" or ")", so trailing
    // ones (outside any string) are spurious: strip them, then let
    // closeUnbalancedBrackets add the real "}". This rescues large HTML/JS writes
    // whose content was otherwise complete and correctly quoted.
    const tailStripped = candidate.replace(/[\s\])]+$/, "");
    if (tailStripped !== candidate && tailStripped.length > 1) {
      const reclosed = this.closeUnbalancedBrackets(tailStripped);
      try {
        const parsed = JSON.parse(reclosed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          this.logger.debug("[PARSER] Salvaged tool call by stripping spurious trailing brackets");
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Fall through to the looser fixes below.
      }
    }

    // Second attempt: Fix common issues
    // 1. Convert unquoted keys to quoted keys: key: value => "key": value
    // 2. Handle Hermes quote marks
    // 3. Support = as separator in addition to :
    let fixed = candidate;

    // Fix unquoted keys at the start of objects/after commas
    fixed = fixed.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_\-]*)\s*([:=])/g, '$1"$2"$3');

    // Handle {"json": {...}} / {"args": {...}} wrapper case - unwrap to the inner object.
    // Anchored to the full string so the match consumes the wrapper's own braces exactly
    // once (an unanchored replace here would swallow the outer closing brace too and leave
    // a dangling duplicate, producing invalid JSON like `{{"action":"create"}}`).
    const jsonWrap = fixed.match(/^\{\s*"json":\s*([^]*)\}\s*$/);
    if (jsonWrap?.[1] !== undefined) {
      fixed = jsonWrap[1].trim();
    }
    const argsWrap = fixed.match(/^\{\s*"args":\s*([^]*)\}\s*$/);
    if (argsWrap?.[1] !== undefined) {
      fixed = argsWrap[1].trim();
    }

    try {
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Will try manual parsing below
    }

    // Third attempt: Manual key-value parsing (most lenient)
    // Falls back to Hermes args parser for last-resort parsing.
    // parseHermesArgs expects a bare "key: value, ..." body - callers pass text both with
    // and without the object's own wrapping braces (e.g. the [TOOL:name({...})] bracket
    // format keeps them, the <|tool_call> Hermes format strips them before calling here),
    // so strip them if still present or the manual parser can't read past the leading `{`.
    const innerBody = normalized.startsWith("{") && normalized.endsWith("}")
      ? normalized.slice(1, -1)
      : normalized;
    const manualResult = this.parseHermesArgs(innerBody);
    if (manualResult) {
      return manualResult;
    }

    // If no separators found, might be empty call like name()
    if (!innerBody.includes("=") && !innerBody.includes(":")) {
      return {};
    }

    return undefined;
  }

  /** Appends whatever closing braces/brackets a truncated JSON-ish string is missing, using
   *  the same string-aware scanning as scanBracketPayload (so brackets embedded in string
   *  values, like the parens in a shell command, are never miscounted). Returns the input
   *  unchanged if it is already balanced or still inside an unterminated string literal -
   *  guessing where an open string was meant to end would risk corrupting real content
   *  instead of fixing a merely-truncated wrapper. */
  private closeUnbalancedBrackets(text: string): string {
    const openStack: string[] = [];
    let inString = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const prevChar = i > 0 ? text[i - 1] : "";

      if (char === '"' && prevChar !== "\\") {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === "{" || char === "[") {
        openStack.push(char);
      } else if (char === "}" || char === "]") {
        const expectedOpener = char === "}" ? "{" : "[";
        if (openStack[openStack.length - 1] === expectedOpener) {
          openStack.pop();
        }
      }
    }

    if (inString || openStack.length === 0) return text;

    const closers = openStack
      .reverse()
      .map((opener) => (opener === "{" ? "}" : "]"))
      .join("");
    return text + closers;
  }

  /**
   * Recover a tool call where the model passed the arguments as an object PLUS extra
   * loose key/value pairs — `func({...}, "offset": 100)` instead of putting `offset`
   * inside the object. The first object closes early and `, "offset": 100` trails it,
   * so JSON.parse fails and jsonrepair turns it into an array. Merge the trailing
   * pairs into the object (`{...}, "offset":100` → `{..., "offset":100}`). Returns
   * undefined when there's nothing to merge (object closes cleanly), leaving valid
   * input untouched.
   */
  private mergeTrailingPairsIntoObject(text: string): string | undefined {
    const t = text.trim();
    if (!t.startsWith("{")) return undefined;
    let depth = 0;
    let inString = false;
    for (let i = 0; i < t.length; i++) {
      const char = t[i];
      const prevChar = i > 0 ? t[i - 1] : "";
      if (char === '"' && prevChar !== "\\") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          const rest = t.slice(i + 1).trim();
          // Something follows the closed object, separated by a comma → merge it in.
          return rest.startsWith(",") ? `${t.slice(0, i)}${t.slice(i + 1)}}` : undefined;
        }
      }
    }
    return undefined;
  }

  /** Serializes a tool result to JSON bounded to maxSize, without ever slicing the
   *  serialized text itself - naively cutting a JSON string at a byte offset (the previous
   *  approach) routinely lands mid-string or mid-escape and produces invalid JSON, which then
   *  breaks two things downstream: the model receives unparseable garbage as the tool result
   *  in the next iteration, and reloading the conversation later re-parses this same content
   *  to decide success/failure (see mapPersistedMessage in ChatContainer.tsx) - a parse
   *  failure there silently defaults to "failed", mislabeling a successful call. Truncating
   *  individual string fields *before* serializing keeps the structure valid at any size. */
  private boundToolResultJson(
    value: unknown,
    maxSize: number,
    maxFieldLength = 4000
  ): { json: string; truncated: boolean; originalSize: number } {
    const original = JSON.stringify(value);
    if (original.length <= maxSize) {
      return { json: original, truncated: false, originalSize: original.length };
    }

    const bounded = this.truncateLargeStrings(value, maxFieldLength);
    const boundedJson = JSON.stringify(bounded);
    if (boundedJson.length <= maxSize) {
      return { json: boundedJson, truncated: true, originalSize: original.length };
    }

    // Per-field truncation still wasn't enough (e.g. many separately-bounded fields) - fall
    // back to a minimal, always-valid summary rather than slicing boundedJson itself.
    // The staging id must survive this path: dropping it leaves the model with "too large,
    // ask more narrowly" and no way to reach the content that was already written to disk,
    // which is precisely how a staged result used to end the run early.
    const stagingId = (value as { data?: { __toolStagingId?: unknown } } | null)?.data?.__toolStagingId;
    // Always include a real content PREVIEW (the head of the per-field-truncated data), not
    // just the "too large" note. Otherwise the model has zero actual content inline and a
    // small model that doesn't issue the follow-up tool_staging read will hallucinate the
    // result. The preview grounds it immediately; the note still points to the full content.
    const previewChars = 1800;
    const preview = boundedJson.length > previewChars
      ? `${boundedJson.slice(0, previewChars)} …[preview truncated — read the staged result for the rest]`
      : boundedJson;
    const summary = {
      success: (value as { success?: boolean } | null)?.success ?? false,
      error: (value as { error?: string } | null)?.error,
      truncated: true,
      __toolStagingId: typeof stagingId === "string" ? stagingId : undefined,
      preview,
      note: stagingId
        ? `Only a PREVIEW of the result is shown above; ${original.length} bytes total. Read the full result with [TOOL:tool_staging({"action":"read","id":"${String(stagingId)}"})] before answering. Do not treat this as finished, and do not invent content beyond the preview.`
        : `Only a PREVIEW is shown (${original.length} bytes total). Ask more narrowly for specific details; do not invent content beyond the preview.`,
    };
    return { json: JSON.stringify(summary), truncated: true, originalSize: original.length };
  }

  /** Recursively truncates long string leaves so a large object still serializes to valid,
   *  bounded JSON (see boundToolResultJson). */
  private truncateLargeStrings(value: unknown, maxFieldLength: number): unknown {
    if (typeof value === "string") {
      return value.length > maxFieldLength
        ? `${value.slice(0, maxFieldLength)}...[truncated, ${value.length - maxFieldLength} more chars]`
        : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.truncateLargeStrings(item, maxFieldLength));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        out[key] = this.truncateLargeStrings(val, maxFieldLength);
      }
      return out;
    }
    return value;
  }

  /** Scans from startPos to find a bracket-delimited payload by counting depth,
   *  correctly handling nested JSON with `]` inside strings/arrays.
   *  Returns the payload body (between [ and ]) and the index of the closing bracket,
   *  or undefined if no closing ] is found (fallback: rest of string).
   */
  private scanBracketPayload(response: string, startPos: number): { body: string; endIndex: number } | undefined {
    if (startPos >= response.length) return undefined;

    let depth = 0;
    let inString = false;

    for (let i = startPos; i < response.length; i++) {
      const char = response[i];
      const prevChar = i > 0 ? response[i - 1] : "";

      // Handle string escaping: "..." where \" inside doesn't flip the flag
      if (char === '"' && prevChar !== "\\") {
        inString = !inString;
      }

      if (!inString) {
        if (char === "{" || char === "[" || char === "(") depth++;
        if (char === "}" || char === "]" || char === ")") {
          depth--;
          // Found closing bracket at depth 0 - accept ] or ) as valid terminators
          // ] for [TOOL:...] format, ) for call:...(...) format
          if (depth < 0 || (depth === 0 && (char === "]" || char === ")"))) {
            return {
              body: response.slice(startPos, i).trim(),
              endIndex: i
            };
          }
        }
      }
    }

    // Fallback: no depth-0 terminator was found, which means the payload is unterminated -
    // almost always because the model's output was truncated mid-call (token limit) before
    // it could emit the closing `})]`. In that case the entire remainder of the response
    // belongs to this one call, so return all of it and let the downstream repair logic
    // (closeUnbalancedBrackets / parseLooseObject) attempt a salvage. The previous version
    // cut the body at the first newline, which corrupted every multi-line payload (e.g. a
    // write_file `content` with real line breaks) by discarding everything after line one.
    return {
      body: response.slice(startPos).trim(),
      endIndex: response.length - 1
    };
  }

  private extractToolCall(response: string): { toolName: string; input: Record<string, unknown> } | undefined {
    // Try new format first: <|tool_call>call:name({...})<tool_call|>
    // Extract by finding the opening <|tool_call>call: and looking for matching closing markers
    const newFormatStart = response.indexOf("<|tool_call>call:");
    if (newFormatStart >= 0) {
      const afterPrefix = response.slice(newFormatStart + "<|tool_call>call:".length);
      const toolNameMatch = afterPrefix.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*\(/);
      if (toolNameMatch?.[1]) {
        const toolName = toolNameMatch[1];
        const openParenPos = afterPrefix.indexOf("(");
        const closingMarker = ")<tool_call|>";
        const closingPos = afterPrefix.indexOf(closingMarker);

        if (openParenPos >= 0 && closingPos > openParenPos) {
          const jsonStr = afterPrefix.slice(openParenPos + 1, closingPos);
          const args = this.parseLooseObject(jsonStr);
          if (args) {
            return this.resolveToolNameAndInput(toolName, args);
          }
        }
      }
    }

    const markerIndex = response.indexOf("[TOOL:");
    const scanResult = markerIndex >= 0 ? this.scanBracketPayload(response, markerIndex + "[TOOL:".length) : undefined;
    const bracketBody = scanResult?.body;

    if (bracketBody) {
      const body = bracketBody;

      // Parse tool name and arguments using string-based extraction (handles large payloads)
      const toolNameMatch = body.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*(.*)$/);
      if (toolNameMatch?.[1]) {
        const toolName = toolNameMatch[1];
        const argsPart = toolNameMatch[2]?.trim() ?? "";

        // Variant A: name({...}) or name({...}) with whitespace
        if (argsPart.startsWith("(") && argsPart.endsWith(")")) {
          const jsonStr = argsPart.slice(1, -1);
          const args = this.parseLooseObject(jsonStr);
          if (args) {
            return this.resolveToolNameAndInput(toolName, args);
          }
        }

        // Variant B: name={...} or name = {...}
        if (argsPart.includes("=")) {
          const eqIdx = argsPart.indexOf("=");
          const jsonStr = argsPart.slice(eqIdx + 1).trim();
          if (jsonStr.startsWith("{") && jsonStr.endsWith("}")) {
            const args = this.parseLooseObject(jsonStr);
            if (args) {
              return this.resolveToolNameAndInput(toolName, args);
            }
          }
        }

        // Variant C: name{...} (compact without parens)
        if (argsPart.startsWith("{") && argsPart.endsWith("}")) {
          const args = this.parseLooseObject(argsPart);
          if (args) {
            return this.resolveToolNameAndInput(toolName, args);
          }
        }
      }

      // Variant D: fallback for malformed payloads like [TOOL:gateway({"a":1}) extra]
      const fallbackMatch = body.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*[:=\(\{](.*)$/);
      if (fallbackMatch?.[1]) {
        const toolName = fallbackMatch[1];
        let tail = fallbackMatch[2] ?? "";
        const firstBrace = tail.indexOf("{");
        const lastBrace = tail.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          const args = this.parseLooseObject(tail.slice(firstBrace, lastBrace + 1));
          if (args) {
            return this.resolveToolNameAndInput(toolName, args);
          }
        }
      }

      return undefined;
    }

    const hermesCall = this.extractHermesCall(response);
    if (hermesCall) {
      const args = this.parseHermesArgs(hermesCall.args) ?? this.parseLooseObject(hermesCall.args);
      if (args) {
        return this.resolveToolNameAndInput(hermesCall.toolName, args);
      }
    }

    return undefined;
  }

  /**
   * Extracts all [TOOL:...] bracket calls from a response using scanBracketPayload,
   * avoiding silent drops of payloads containing `]` (array values, strings with brackets).
   * Returns found calls plus unparsed markers for guardrail reporting.
   */
  /**
   * Check if a tool can safely be called with empty/default arguments.
   * Stateless tools (shell, filesystem, etc) can use fallback with empty args.
   * Stateful tools (browser, etc) require specific parameters and should fail.
   */
  private canUseFallbackEmptyArgs(toolName: string): boolean {
    const statelessTools = new Set([
      "shell", "http", "task", "project", "memory", "workflow",
      "history", "git", "skill_manage", "plan"
    ]);
    return statelessTools.has(toolName.toLowerCase());
  }

  /**
   * Adapt provider-native structured tool calls into the same shape extractAllToolCalls
   * produces, so the whole downstream pipeline (dedup, execution graph, guardrails) is
   * identical regardless of how the call was obtained. The native `arguments` field is a
   * JSON string per the OpenAI spec, but we still route it through parseLooseObject so a
   * lenient local backend that emits slightly-off JSON is repaired rather than dropped.
   * The tool name is resolved through the same alias/skill mapping as the text path.
   */
  private nativeToolCallsToExtractResult(nativeCalls: ToolCall[]): {
    calls: Array<{ toolName: string; input: Record<string, unknown> }>;
    markerCount: number;
    unparsed: string[];
  } {
    const calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const unparsed: string[] = [];
    for (const call of nativeCalls) {
      const rawName = call.function?.name ?? "";
      const rawArgs = call.function?.arguments ?? "";
      const parsedArgs = this.parseLooseObject(rawArgs) ?? {};
      if (!rawName) {
        unparsed.push(`<native:${JSON.stringify(call)}>`);
        continue;
      }
      // Native calls carry content in a structured, server-validated field - no tool-call
      // syntax can have leaked into it, so mark it trusted for the scoped filesystem tool.
      if (typeof parsedArgs["content"] === "string" || typeof parsedArgs["contents"] === "string") {
        parsedArgs["__contentTrusted"] = true;
      }
      const resolved = this.resolveToolNameAndInput(rawName, parsedArgs);
      calls.push(resolved);
    }
    return { calls, markerCount: nativeCalls.length, unparsed };
  }

  /**
   * Parse the `key=value` pairs on a heredoc header line. Supports bare values
   * (action=write), double- and single-quoted values (title="my file"). Values never
   * span the newline because the header regex stops the run at the closing `]`.
   */
  private parseHeredocHeader(headerRest: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const pairRe = /([A-Za-z_][A-Za-z0-9_\-]*)\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/g;
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(headerRest)) !== null) {
      const key = m[1];
      if (!key) continue;
      out[key] = m[3] ?? m[4] ?? m[5] ?? "";
    }
    return out;
  }

  /**
   * Extract heredoc-style tool calls:
   *
   *   [TOOL:filesystem action=write path=index.html]
   *   ...raw file content, no escaping needed...
   *   [/TOOL]
   *
   * The header carries scalar args as `key=value`; everything between the header's
   * newline and the closing `[/TOOL]` becomes the `content` field verbatim. The header
   * char class forbids `(` `{` so a normal JSON call `[TOOL:name({...})]` is never
   * mistaken for a heredoc. Returns the matched calls plus `remaining` (the input with
   * every heredoc block removed) so the caller's other scanners don't double-process.
   */
  private extractHeredocCalls(response: string): {
    calls: Array<{ toolName: string; input: Record<string, unknown> }>;
    markerCount: number;
    unparsed: string[];
    remaining: string;
  } {
    const calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const unparsed: string[] = [];
    let markerCount = 0;
    // Header: [TOOL:name <key=value pairs>] on its own line (no ( { in the header),
    // then a newline, lazily up to the first [/TOOL] terminator.
    // The body may not contain another `[TOOL:` opener.
    //
    // Without that guard the lazy match ran to the first `[/TOOL]` ANYWHERE below, so when a
    // model forgot to close its write block and went straight on to its next call, that call
    // was captured as file content:
    //
    //   [TOOL:filesystem action=write path=index.html]
    //   <html>…</html>
    //   [TOOL:todo action=update id=1 status=done]      <-- ended up inside index.html
    //   [/TOOL]
    //
    // A body that trips this lookahead makes the strict match fail at that position, and the
    // tolerant pass below picks the call up instead - it ends the body at the nested marker,
    // which is exactly where the file content ends.
    const blockRe = /\[TOOL:([A-Za-z_][A-Za-z0-9_\-]*)([^\]\n(){}]*)\]\r?\n((?:(?!\[TOOL:)[\s\S])*?)\r?\n?\[\/TOOL\]/g;
    const matchedBlocks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(response)) !== null) {
      const toolName = m[1];
      const headerRest = m[2] ?? "";
      const body = m[3] ?? "";
      // A header with no key=value pairs and an empty body is almost certainly not a real
      // heredoc write — skip it so we don't fabricate an empty content call.
      const headerArgs = this.parseHeredocHeader(headerRest);
      if (!toolName) {
        unparsed.push(m[0]);
        matchedBlocks.push(m[0]);
        continue;
      }
      markerCount++;
      matchedBlocks.push(m[0]);
      // __contentTrusted: the body was taken verbatim (never through a JSON string), so the
      // scoped filesystem tool can skip its leak-stripping heuristics on this content.
      const input: Record<string, unknown> = { ...headerArgs, content: body, __contentTrusted: true };
      const parsed = this.resolveToolNameAndInput(toolName, input);
      if (parsed) {
        calls.push(parsed);
      } else {
        unparsed.push(m[0]);
      }
    }
    // Remove matched blocks from the text (indexOf/splice by exact substring keeps this
    // safe even if two blocks are identical).
    let remaining = response;
    for (const block of matchedBlocks) {
      const idx = remaining.indexOf(block);
      if (idx >= 0) {
        remaining = remaining.slice(0, idx) + remaining.slice(idx + block.length);
      }
    }

    // Second, tolerant pass over whatever the strict one did not claim.
    const hybrid = this.extractHybridHeredocCalls(remaining);
    return {
      calls: [...calls, ...hybrid.calls],
      markerCount: markerCount + hybrid.markerCount,
      unparsed,
      remaining: hybrid.remaining,
    };
  }

  /**
   * Rescues the hybrid form: a bracket-syntax HEADER followed by a raw heredoc BODY.
   *
   *   [TOOL:filesystem(action="write", path="index.html")]
   *   <!DOCTYPE html>
   *   ...10 KB of HTML, no [/TOOL] terminator...
   *
   * Models mix the two documented shapes under load, and this particular mixture was silently
   * fatal. The strict heredoc matcher rejects it twice over - its header class forbids `(`
   * (deliberately, so a JSON call is never mistaken for a heredoc) and it requires a closing
   * `[/TOOL]`. The JSON scanner then took over, parsed `action="write", path="index.html"` into
   * the broken keys `action=` and `path=`, and left the 10 KB body lying in the response as
   * prose. The file was created empty while the whole document sat visible in the transcript.
   *
   * Acceptance is deliberately narrow, so a well-formed JSON call can never be swallowed:
   * the header must parse into an actual `write`/`append` action WITH a path and WITHOUT a
   * body, and there must be a non-empty body under it. A JSON header (`{"action":"write"}`)
   * yields no `key=value` pairs at all and is therefore never eligible.
   */
  private extractHybridHeredocCalls(response: string): {
    calls: Array<{ toolName: string; input: Record<string, unknown> }>;
    markerCount: number;
    remaining: string;
  } {
    const calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    let markerCount = 0;
    let remaining = response;

    // Header on its own line, followed by a newline. `(` is allowed here - that is the whole
    // point - so the body-shape checks below carry the burden of not over-matching.
    const headerRe = /\[TOOL:([A-Za-z_][A-Za-z0-9_\-]*)([^\]\n]*)\]\r?\n/g;
    const consumed: string[] = [];
    let m: RegExpExecArray | null;

    while ((m = headerRe.exec(response)) !== null) {
      const toolName = m[1];
      if (!toolName) continue;

      const headerArgs = this.parseHeredocHeader(this.unwrapHeaderParens(m[2] ?? ""));
      const action = String(headerArgs["action"] ?? "").toLowerCase();
      if (action !== "write" && action !== "append") continue;
      if (!headerArgs["path"]) continue;
      // A header that already carries the body is a normal call - not this failure mode.
      if (extractFileContent(headerArgs) !== undefined) continue;

      // Body runs to the first terminator: an explicit [/TOOL], the next call, or the end.
      const bodyStart = m.index + m[0].length;
      const rest = response.slice(bodyStart);
      const terminators = [rest.indexOf("[/TOOL]"), rest.indexOf("[TOOL:")].filter((i) => i >= 0);
      const bodyEnd = terminators.length > 0 ? Math.min(...terminators) : rest.length;
      const body = rest.slice(0, bodyEnd).replace(/\r?\n$/, "");
      if (body.trim().length === 0) continue;

      markerCount++;
      const input: Record<string, unknown> = {
        ...headerArgs,
        content: body,
        // Taken verbatim, never through a JSON string - the leak-stripping heuristics would
        // only risk damaging it.
        __contentTrusted: true,
      };
      const parsed = this.resolveToolNameAndInput(toolName, input);
      if (parsed) {
        calls.push(parsed);
        consumed.push(response.slice(m.index, bodyStart + bodyEnd));
      }
    }

    for (const block of consumed) {
      const idx = remaining.indexOf(block);
      if (idx >= 0) remaining = remaining.slice(0, idx) + remaining.slice(idx + block.length);
    }

    return { calls, markerCount, remaining };
  }

  /** Strips a wrapping `( ... )` from a header's argument list and drops separator commas, so
   *  `(action="write", path="x")` parses with the same key=value reader as ` action=write path=x`. */
  private unwrapHeaderParens(headerRest: string): string {
    return headerRest.replace(/^\s*\(/, " ").replace(/\)\s*$/, " ").replace(/,/g, " ");
  }

  /**
   * Detects the "showed the code instead of writing it" failure mode: the model emits a
   * substantial markdown code fence (```html/js/... a file's worth of content) but never
   * emits a `[TOOL:...]` marker at all, so nothing gets written — the fence just renders
   * as inert text. This is distinct from the malformed/unparsed-marker guardrail above,
   * which only fires when a `[TOOL:` marker IS present but broken; here there is no marker
   * to begin with, so extractAllToolCalls silently returns zero calls with nothing to flag.
   * Weaker/local models fall back to this plain-markdown habit under load even when the
   * system prompt explicitly requires the heredoc block form (see large-file-writing skill).
   */
  private detectUnexecutedCodeFence(response: string): { language: string; lineCount: number } | null {
    if (response.includes("[TOOL:")) return null; // handled by the marker-based guardrail instead

    const fileLikeLangs = new Set([
      "html", "htm", "xml", "css", "scss", "js", "jsx", "ts", "tsx", "json", "yaml", "yml",
      "py", "python", "java", "c", "cpp", "cs", "php", "go", "rs", "rust", "sql", "sh", "bash", "ps1",
    ]);
    const fenceRe = /```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)```/g;
    let best: { language: string; lineCount: number } | null = null;
    let match: RegExpExecArray | null;
    while ((match = fenceRe.exec(response)) !== null) {
      const language = (match[1] || "").toLowerCase();
      const body = match[2] ?? "";
      const lineCount = body.split("\n").filter((l) => l.trim().length > 0).length;
      // Require either a recognized file-ish language, or enough lines that it reads as a
      // real file rather than a short illustrative snippet in a normal explanation.
      if (lineCount >= 8 && (fileLikeLangs.has(language) || lineCount >= 20)) {
        if (!best || lineCount > best.lineCount) best = { language: language || "text", lineCount };
      }
    }
    return best;
  }

  /**
   * Detects the "narrated a fake success" failure mode: the model writes prose CLAIMING a
   * tool ran and the work is done/submitted, but emits no `[TOOL:...]` marker and no native
   * tool_call, so nothing actually happened. Distinct from detectUnexecutedCodeFence (which
   * needs a code fence) - this fires on pure prose, e.g. weak local models that fall back to
   * the text protocol sometimes invent a plausible-sounding tool name (borrowed from the tool
   * list in the system prompt, e.g. "the gateway tool") and narrate a completed action instead
   * of emitting the marker. Only ever checked when toolResultsMap.size === 0 for this
   * iteration, so it can never misfire on a genuine summary written after a real tool result.
   */
  private detectFalseCompletionClaim(response: string): boolean {
    if (response.includes("[TOOL:")) return false; // a real marker is present, handled elsewhere

    const patterns = [
      // "the X tool was executed/ran/invoked" / "das X-Tool wurde ausgeführt"
      /\b(tool)\b[\s\S]{0,60}\b(was|were|has been|have been)\s+(executed|run|called|invoked)\b/i,
      /\btool[\s\S]{0,40}\bwurde\s+(erfolgreich\s+)?(ausgeführt|aufgerufen)\b/i,
      // "submitted/delivered as the final solution" / "als finale Lösung übermittelt"
      /\b(submitted|delivered)\b[\s\S]{0,40}\bas\s+(the\s+)?final\s+(solution|answer|result)\b/i,
      /\b(übermittelt|eingereicht|abgegeben)\b[\s\S]{0,40}\bals\s+(die\s+)?(finale|endgültige)\s+(lösung|antwort)\b/i,
      // "all files were submitted/written/created" / "alle Dateien wurden übermittelt/erstellt"
      /\b(files?)\b[\s\S]{0,40}\b(were|was)\s+(submitted|written|created|saved)\b/i,
      /\b(dateien?)\b[\s\S]{0,40}\b(wurden?|wurde)\s+(übermittelt|geschrieben|erstellt|gespeichert)\b/i,
    ];
    return patterns.some((re) => re.test(response));
  }

  /**
   * True if `text` is (or is dominated by) a JSON object using the reflection evaluation
   * schema - "quality"/"issues"/"suggestions"/"shouldRetry" - rather than prose. Used to stop
   * a confused reflection-pass model from having its own self-critique JSON adopted as the
   * user-facing response (see Reflection & Self-Improvement Loop).
   */
  private looksLikeReflectionSchemaLeak(text: string): boolean {
    const trimmed = text.trim();
    const candidate = trimmed.startsWith("```")
      ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
      : trimmed;
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) return false;

    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        const keys = Object.keys(parsed);
        const schemaKeyHits = ["quality", "issues", "suggestions", "shouldRetry"].filter((k) =>
          keys.includes(k)
        ).length;
        return schemaKeyHits >= 2;
      }
    } catch {
      // Not valid JSON at all - not a schema leak, just an unusual (but real) answer.
    }
    return false;
  }

  private extractAllToolCalls(response: string): {
    calls: Array<{ toolName: string; input: Record<string, unknown> }>;
    markerCount: number;
    unparsed: string[];
  } {
    const calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const unparsed: string[] = [];
    let markerCount = 0;

    // Heredoc write format FIRST — this is the safest way for weak local models to write
    // a file: the body between the header and [/TOOL] is taken verbatim, so the model
    // never has to JSON-escape newlines/quotes or land the exact `"})]` terminator (the
    // #1 source of tool-call syntax leaking into written files). Matched blocks are cut
    // from the text so the JSON [TOOL:...] scanner below never re-parses the header line.
    const heredoc = this.extractHeredocCalls(response);
    for (const c of heredoc.calls) calls.push(c);
    markerCount += heredoc.markerCount;
    for (const u of heredoc.unparsed) unparsed.push(u);
    response = heredoc.remaining;

    // Extract [TOOL:...] format (legacy)
    let fromIndex = 0;
    while (true) {
      const markerIndex = response.indexOf("[TOOL:", fromIndex);
      if (markerIndex < 0) break;

      markerCount++;
      const scanResult = this.scanBracketPayload(response, markerIndex + "[TOOL:".length);
      if (!scanResult) {
        fromIndex = markerIndex + "[TOOL:".length;
        continue;
      }

      const body = scanResult.body;
      const parsed = this.parseBracketBody(body);
      if (parsed) {
        calls.push(parsed);
      } else {
        unparsed.push(`[TOOL:${body}]`);
      }

      fromIndex = scanResult.endIndex + 1;
    }

    // Extract <|tool_call>call:toolName(...)<tool_call|> format
    fromIndex = 0;
    while (true) {
      const markerIndex = response.indexOf("<|tool_call>call:", fromIndex);
      if (markerIndex < 0) break;

      markerCount++;
      const afterPrefix = response.slice(markerIndex + "<|tool_call>call:".length);
      const toolNameMatch = afterPrefix.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*\(/);
      if (!toolNameMatch?.[1]) {
        fromIndex = markerIndex + "<|tool_call>call:".length;
        continue;
      }

      const toolName = toolNameMatch[1];
      const openParenPos = afterPrefix.indexOf("(");
      const closingMarker = ")<tool_call|>";
      const closingPos = afterPrefix.indexOf(closingMarker);

      if (openParenPos >= 0 && closingPos > openParenPos) {
        const body = afterPrefix.slice(openParenPos + 1, closingPos);
        const args = this.parseLooseObject(body);
        if (args) {
          const parsed = this.resolveToolNameAndInput(toolName, args);
          if (parsed) {
            calls.push(parsed);
          }
        } else if (this.canUseFallbackEmptyArgs(toolName)) {
          // Fallback: try calling with empty args if parsing failed (only for stateless tools)
          const parsed = this.resolveToolNameAndInput(toolName, {});
          if (parsed) {
            this.logger.debug("[PARSER] Fallback: <|tool_call> format with empty args", { toolName, body });
            calls.push(parsed);
          } else {
            unparsed.push(`<|tool_call>call:${toolName}(${body})<tool_call|>`);
          }
        } else {
          // Don't fallback for stateful tools - incomplete args are too risky
          unparsed.push(`<|tool_call>call:${toolName}(${body})<tool_call|>`);
        }
        fromIndex = markerIndex + "<|tool_call>call:".length + closingPos + closingMarker.length;
      } else {
        fromIndex = markerIndex + "<|tool_call>call:".length;
      }
    }

    // Extract call:toolName(...) and call:toolName{...} formats (Claude 5 API)
    fromIndex = 0;
    while (true) {
      const callIndex = response.indexOf("call:", fromIndex);
      if (callIndex < 0) break;

      // Skip if this is part of <|tool_call>call: (already handled above)
      if (callIndex > 0 && response.slice(callIndex - 17, callIndex) === "<|tool_call>call:") {
        fromIndex = callIndex + "call:".length;
        continue;
      }

      markerCount++;
      const afterCall = response.slice(callIndex + "call:".length);

      // Try to match: call:toolName(...) with parens
      let callMatch = afterCall.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*\(/);
      let toolName = callMatch?.[1];
      let openParenPos = callMatch?.[0].length ? callMatch[0].length - 1 : -1;

      // If no parens, try: call:toolName{...} without parens (compact format)
      if (!toolName) {
        callMatch = afterCall.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*\{/);
        if (callMatch?.[1]) {
          toolName = callMatch[1];
          openParenPos = callMatch[0].length - 1; // Position of {
          // Handle as brace payload
          const braceResult = this.scanBracketPayload(afterCall, openParenPos + 1);
          if (braceResult) {
            const body = braceResult.body;
            const args = this.parseLooseObject(body);
            if (args) {
              const parsed = this.resolveToolNameAndInput(toolName, args);
              if (parsed) {
                calls.push(parsed);
              }
            } else {
              unparsed.push(`call:${toolName}{${body}}`);
            }
            fromIndex = callIndex + "call:".length + braceResult.endIndex + 1;
            continue;
          }
        }
        fromIndex = callIndex + "call:".length;
        continue;
      }

      const scanResult = this.scanBracketPayload(afterCall, openParenPos + 1);
      if (!scanResult) {
        fromIndex = callIndex + "call:".length;
        continue;
      }

      const body = scanResult.body;
      const args = this.parseLooseObject(body);
      if (args) {
        const parsed = this.resolveToolNameAndInput(toolName, args);
        if (parsed) {
          calls.push(parsed);
        }
      } else if (toolName && /^[A-Za-z_][A-Za-z0-9_\-]*$/.test(toolName) && this.canUseFallbackEmptyArgs(toolName)) {
        // Fallback: try calling with empty args if parsing failed (only for stateless tools)
        this.logger.debug("[PARSER] Fallback: call format with empty args", { toolName, body });
        const parsed = this.resolveToolNameAndInput(toolName, {});
        if (parsed) {
          calls.push(parsed);
        } else {
          unparsed.push(`call:${toolName}(${body})`);
        }
      } else {
        unparsed.push(`call:${toolName}(${body})`);
      }

      fromIndex = callIndex + "call:".length + scanResult.endIndex + 1;
    }

    return { calls, markerCount, unparsed };
  }

  /**
   * Parses a single [TOOL:...] bracket body into a tool call, using the same variant
   * matching as extractToolCall. Kept standalone (not shared code) so extractToolCall's
   * hardened malformed-input handling stays untouched - this only backs the additive
   * multi-call batch path in extractAllToolCalls above.
   */
  private parseBracketBody(body: string): { toolName: string; input: Record<string, unknown> } | undefined {
    // name(...) form. The old regex `\(([^]*?)\)` matched lazily up to the *first* `)`,
    // which truncated any argument value containing parentheses (e.g. a document with
    // "(HTN)" or "(Agent Evolution)") mid-string and dropped the whole call. Extract the
    // argument span manually instead: everything after the first `(`, minus an optional
    // trailing `)`. Note scanBracketPayload accepts `)` as a depth-0 terminator, so `body`
    // usually already ends at the object's closing `}` with the call's `)` stripped - the
    // optional-strip handles both that case and a body that still carries the `)`.
    const parenNameMatch = body.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*\(/);
    if (parenNameMatch?.[1]) {
      let inner = body.slice(body.indexOf("(") + 1).trim();
      if (inner.endsWith(")")) inner = inner.slice(0, -1).trim();

      // A parenthesised argument list that is NOT a JSON object is a key=value list, e.g.
      // `filesystem(action="write", path="a.md", content="…")`. Handing that to the loose JSON
      // reader produced keys with the `=` still attached - `action=`, `path=` - so the call
      // carried no recognisable action, no path and no content, and the write silently did
      // nothing. There is already a correct key=value reader; it just ran too late to be
      // reached, because this branch "succeeded" with garbage first.
      if (!inner.startsWith("{") && /[A-Za-z_][A-Za-z0-9_\-]*\s*=/.test(inner)) {
        const pairArgs = this.parseHeredocHeader(this.unwrapHeaderParens(inner));
        if (Object.keys(pairArgs).length > 0) {
          return this.resolveToolNameAndInput(parenNameMatch[1], pairArgs);
        }
      }

      const args = this.parseLooseObject(inner || "{}");
      if (args) return this.resolveToolNameAndInput(parenNameMatch[1], args);
    }

    const equalsMatch = body.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*=\s*(\{[^]*\})/);
    if (equalsMatch?.[1]) {
      const args = this.parseLooseObject(equalsMatch[2] ?? "{}");
      if (args) return this.resolveToolNameAndInput(equalsMatch[1], args);
    }

    const compactObjectMatch = body.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*(\{[^]*\})/);
    if (compactObjectMatch?.[1]) {
      const args = this.parseLooseObject(compactObjectMatch[2] ?? "{}");
      if (args) return this.resolveToolNameAndInput(compactObjectMatch[1], args);
    }

    const fallbackMatch = body.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*[:=\(\{](.*)$/);
    if (fallbackMatch?.[1]) {
      const toolName = fallbackMatch[1];
      const tail = fallbackMatch[2] ?? "";
      const firstBrace = tail.indexOf("{");
      const lastBrace = tail.lastIndexOf("}");
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        const args = this.parseLooseObject(tail.slice(firstBrace, lastBrace + 1));
        if (args) return this.resolveToolNameAndInput(toolName, args);
      }
    }

    // Variant E: space-separated key=value args on one line, e.g.
    //   filesystem action=write path=./report.md content="# Title\n- item (source) <url>"
    // Weaker models routinely emit this instead of JSON or the [/TOOL] heredoc. Every JSON/
    // brace variant above fails on it, so the whole call — usually a file write — was dropped
    // as unparsed and the file was never written (the checklist's "save report" step then
    // failed). Runs late so it never shadows a genuine JSON payload. Quote-aware so values may
    // contain '(', ')', '<', '>' and escaped newlines.
    const kvNameMatch = body.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s+([\s\S]+)$/);
    if (kvNameMatch?.[1] && kvNameMatch[2] && /^[A-Za-z_][A-Za-z0-9_\-]*\s*=/.test(kvNameMatch[2].trimStart())) {
      const args = this.parseSpaceSeparatedKeyValues(kvNameMatch[2]);
      if (Object.keys(args).length > 0) {
        return this.resolveToolNameAndInput(kvNameMatch[1], args);
      }
    }

    // Last resort: if we can extract just the tool name with no arguments
    // For stateless tools (shell, filesystem, etc), call with empty args
    // For stateful tools (browser, etc), better to fail than execute with incomplete state
    const toolNameOnly = body.match(/^([A-Za-z_][A-Za-z0-9_\-]*)(?:\s|$)/);
    if (toolNameOnly?.[1]) {
      const toolName = toolNameOnly[1];

      if (this.canUseFallbackEmptyArgs(toolName)) {
        this.logger.debug("[PARSER] Fallback: stateless tool with empty args", { toolName, body });
        return this.resolveToolNameAndInput(toolName, {});
      } else {
        this.logger.debug("[PARSER] Fallback rejected for stateful tool", { toolName, body, reason: "requires_specific_args" });
        // Don't use fallback for stateful tools like browser that need specific parameters
      }
    }

    return undefined;
  }


  /**
   * Parse space-separated `key=value` pairs from a one-line bracket tool call, where values
   * may be bare (`action=write`), double- or single-quoted, and quoted values may contain
   * spaces, parentheses, angle brackets and escaped characters. Quoted values are unescaped
   * (`\n`→newline, `\t`, `\r`, `\"`, `\\`) so a model that wrote `content="a\nb"` produces a
   * file with a real line break. Bare values are taken verbatim.
   */
  private parseSpaceSeparatedKeyValues(rest: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    // Value alternatives: "double" | 'single' | bareword. The quoted forms allow escaped
    // characters (\\.) so an internal \" does not end the value early.
    const pairRe = /([A-Za-z_][A-Za-z0-9_\-]*)\s*=\s*("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/g;
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(rest)) !== null) {
      const key = m[1];
      if (!key) continue;
      if (m[3] !== undefined) out[key] = this.unescapeInlineValue(m[3]);
      else if (m[4] !== undefined) out[key] = this.unescapeInlineValue(m[4]);
      else out[key] = m[5] ?? "";
    }
    return out;
  }

  /** Unescape the common backslash sequences a model uses inside a quoted tool-call value. */
  private unescapeInlineValue(value: string): string {
    return value.replace(/\\(["'\\nrt])/g, (_match, ch: string) => {
      switch (ch) {
        case "n": return "\n";
        case "r": return "\r";
        case "t": return "\t";
        default: return ch; // \" \' \\
      }
    });
  }

  private buildToolCallSignature(toolName: string, input: Record<string, unknown>): string {
    const stable = JSON.stringify(input, Object.keys(input).sort());
    return `${toolName}:${stable}`;
  }

  private deriveToolRecoveryHint(toolName: string, toolInput: Record<string, unknown>, error: string): string | undefined {
    const normalizedTool = toolName.toLowerCase();
    const normalizedError = error.toLowerCase();

    if (normalizedTool === "shell") {
      if (/(grep|sed|awk|tail|head)/.test(String(toolInput["command"] ?? "")) && /(not found|konnte nicht gefunden|wurde nicht gefunden)/.test(normalizedError)) {
        return "Shell hint: On Windows use PowerShell-compatible commands or run the command via bash. Do not use Linux paths like /home/...";
      }
      if (/(\/home\/|\/dev\/null)/.test(String(toolInput["command"] ?? ""))) {
        return "Shell hint: Linux path detected. Adjust paths for Windows (e.g. C:/... or relative workspace paths).";
      }
    }

    // Filesystem recovery hints in English: recovery steps are LLM/agent-specific, not user-facing.
    if (normalizedTool === "filesystem") {
      if (/oldstring is not unique/.test(normalizedError)) {
        return "Expand oldString with more surrounding context to make it unique, or set replaceAll:true to replace all occurrences.";
      }
      if (/oldstring not found/.test(normalizedError)) {
        return "Re-read the file with action:'read' to see the exact text, then copy it exactly including indentation; do not retype from memory.";
      }
      if (/path is outside|outside shared workspace|outside basepath scope/.test(normalizedError)) {
        return "Use a path relative to the project root: no leading /, no drive letter, no .. traversal. Example: 'src/app.ts' instead of 'C:/...'.";
      }
      if (/(file not found|path not found)/.test(normalizedError)) {
        return "Call action:'list' on the parent directory first to confirm the path exists. Example: list the directory before trying to read.";
      }
      if (/refusing to write invalid json/.test(normalizedError)) {
        return "Make a targeted edit instead of rewriting the whole file: use action:'edit' with oldString and newString to surgically fix the JSON.";
      }
      if (/read-before-write/.test(normalizedError)) {
        return "You must call action:'read' on this path first before modifying it. Read the file, then use edit or write.";
      }
      if (/requires string field.*content/.test(normalizedError)) {
        return "For write/append, pass the full content as a string in the 'content' field. Use \\n for newlines and \\\\ for backslashes.";
      }
    }

    if (normalizedTool === "browser") {
      if (/selector is required/.test(normalizedError)) {
        return "Browser hint: click needs a CSS 'selector'. For type, either pass 'selector' + 'text', or click/focus the field first and then call type with just 'text' to type into the focused element.";
      }
      if (/type requires 'text'/.test(normalizedError)) {
        return "Browser hint: the type action needs a non-empty 'text' value (optionally a 'selector' too).";
      }
    }

    if (normalizedTool === "task" && /unknown task action/.test(normalizedError)) {
      return "Task hint: Allowed actions are create, list, get, update, start, complete, fail, delete.";
    }

    if (normalizedTool === "history" && /unknown history action/.test(normalizedError)) {
      return "History hint: Allowed actions are search, list_conversations, get_messages, get_conversation.";
    }

    // Gateway (Discord/Telegram/Webhook outbound) — steer the agent to self-serve: discover
    // the available config + its default channel, then retry send. These are the config-level
    // failures that field-name aliasing cannot fix; a clear recovery path lets the agent
    // operate the gateway autonomously instead of stalling.
    if (normalizedTool === "gateway") {
      if (/no matching enabled gateway config/.test(normalizedError)) {
        return "Gateway hint: First call gateway with action:'list_configs' to see the enabled portals and their ids. Then call action:'send' — pass configId (or portal, e.g. 'discord') for the one you want, plus message. Do NOT invent a configId.";
      }
      if (/no target id provided/.test(normalizedError)) {
        return "Gateway hint: This config has no default channel. Call action:'list_configs' to read each config's defaultTarget; if one is present, retry send with that config. Otherwise set channelId to the exact Discord channel id (a numeric snowflake) you want to post to.";
      }
      if (/requires field 'message'/.test(normalizedError)) {
        return "Gateway hint: action:'send' needs the message text in the 'message' field (aliases content/text/body also work). Put the full report text there.";
      }
      if (/unknown gateway action|action is required/.test(normalizedError)) {
        return "Gateway hint: Allowed actions are 'list_configs' (discover portals/channels) and 'send' (deliver a message). Use list_configs first if unsure which portal/channel exists.";
      }
    }

    if (/unknown tool/.test(normalizedError)) {
      return "Tool hint: Check the tool name against the available tools and use a known alias if applicable.";
    }

    return undefined;
  }

  /**
   * Deterministic, non-LLM repair: snaps invalid enum-typed parameter values (e.g. a
   * misspelled `action`) to the nearest value declared in the tool's own schema.
   */
  private deriveMechanicalRepair(
    toolName: string,
    toolInput: Record<string, unknown>
  ): { toolName: string; input: Record<string, unknown> } | undefined {
    const definition = this.executor.getToolDefinitions().find((d) => d.name === toolName);
    const properties = (definition?.parameters as { properties?: Record<string, { enum?: unknown[] }> } | undefined)
      ?.properties;
    if (!properties) return undefined;

    let changed = false;
    const correctedInput: Record<string, unknown> = { ...toolInput };

    // 1. Reconcile field NAMES against the schema before looking at values.
    //
    // Models mix conventions constantly - `old_string` for `oldString`, `max_results` for
    // `maxResults`, `file_path` for `path`. Each of those is a perfectly well-formed call that
    // fails on a spelling technicality, and renaming the key is a deterministic fix that needs
    // no model round-trip. Matching is done on a normalised form (lowercase, punctuation
    // stripped), so only genuine case/separator variants collapse onto a schema field.
    const normalizeKey = (key: string): string => key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const schemaByNormalized = new Map(Object.keys(properties).map((key) => [normalizeKey(key), key]));

    /** Semantic aliases: different words for the same parameter, which normalisation cannot catch. */
    const SEMANTIC_ALIASES: Record<string, readonly string[]> = {
      path: ["filepath", "filename", "file", "targetpath", "target"],
    };

    for (const [inputKey, value] of Object.entries(toolInput)) {
      if (inputKey in properties) continue;
      const normalized = normalizeKey(inputKey);

      let schemaKey = schemaByNormalized.get(normalized);
      if (!schemaKey) {
        schemaKey = Object.keys(SEMANTIC_ALIASES).find(
          (candidate) => candidate in properties && SEMANTIC_ALIASES[candidate]!.includes(normalized)
        );
      }
      // Never overwrite a value the model already supplied under the correct name.
      if (!schemaKey || correctedInput[schemaKey] !== undefined) continue;

      correctedInput[schemaKey] = value;
      delete correctedInput[inputKey];
      changed = true;
    }

    // 2. Enum values: fix a near-miss spelling of an allowed value.
    for (const [key, schema] of Object.entries(properties)) {
      const enumValues = Array.isArray(schema?.enum)
        ? schema.enum.filter((v): v is string => typeof v === "string")
        : undefined;
      if (!enumValues || enumValues.length === 0) continue;

      // Read from correctedInput: a key renamed in step 1 must still get its value checked.
      const current = correctedInput[key];
      if (typeof current !== "string" || current.trim().length === 0) continue;
      if (enumValues.includes(current)) continue;

      const nearest = this.nearestEnumMatch(current, enumValues);
      if (nearest) {
        correctedInput[key] = nearest;
        changed = true;
      }
    }

    if (!changed) return undefined;
    return { toolName, input: correctedInput };
  }

  private nearestEnumMatch(value: string, candidates: string[]): string | undefined {
    const normalized = value.trim().toLowerCase();
    let best: string | undefined;
    let bestDistance = Infinity;

    for (const candidate of candidates) {
      const candidateNormalized = candidate.toLowerCase();
      if (candidateNormalized === normalized) return candidate;
      const distance = this.levenshtein(normalized, candidateNormalized);
      const threshold = Math.max(2, Math.floor(candidateNormalized.length * 0.4));
      if (distance <= threshold && distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }

    return best;
  }

  private levenshtein(a: string, b: string): number {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const matrix: number[][] = Array.from({ length: rows }, (_, i) => {
      const row = new Array<number>(cols).fill(0);
      row[0] = i;
      return row;
    });
    for (let j = 0; j < cols; j++) {
      const row = matrix[0];
      if (row) row[j] = j;
    }

    for (let i = 1; i < rows; i++) {
      for (let j = 1; j < cols; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const current = matrix[i];
        const previous = matrix[i - 1];
        if (!current || !previous) continue;
        current[j] = Math.min(
          previous[j]! + 1,
          current[j - 1]! + 1,
          previous[j - 1]! + cost
        );
      }
    }

    return matrix[rows - 1]?.[cols - 1] ?? Math.max(a.length, b.length);
  }

  /**
   * Best-effort JSON extraction from an LLM response: handles raw JSON, JSON wrapped in
   * markdown code fences, and JSON embedded with surrounding prose.
   */
  private extractJsonObject(text: string): Record<string, unknown> | undefined {
    const trimmed = text.trim();
    const tryParse = (raw: string): Record<string, unknown> | undefined => {
      try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      } catch {
        return undefined;
      }
    };

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced?.[1]?.trim() ?? trimmed;

    const direct = tryParse(candidate);
    if (direct) return direct;

    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return tryParse(candidate.slice(start, end + 1));
    }

    return undefined;
  }

  /**
   * Attempts to produce a corrected {toolName, input} for a failed tool call: first via
   * deterministic schema-based fixes, then (if none apply) by asking the LLM for a
   * targeted correction. Returns undefined if no repair could be derived.
   */
  /**
   * Self-repair may fix the SHAPE of a call. It must never touch the payload.
   *
   * Two ways it silently destroyed a file, both observed:
   *   - It set `allowEmpty: true`. The empty-content error explains that flag as the way to
   *     write a 0-byte file on purpose, and the repair model reads that error - so it did the
   *     one thing that makes the complaint go away, turning "this write was truncated" into
   *     "wrote an empty file, successfully".
   *   - It re-emitted the call with a shortened or missing `content`. A small repair model
   *     asked to fix a call carrying a 6KB HTML document will not reproduce that document; it
   *     produces something shorter, and the user's file is quietly replaced by it.
   *
   * So: the file body must come out of a repair byte-identical to how it went in. Aliases are
   * resolved on both sides first, which still permits the useful repair of moving a body from
   * `file_text` to `content`. Anything else discards the repair - the acting model, which
   * actually has the content, then gets the error and can re-send it.
   */
  private sanitizeRepairedInput(
    toolName: string,
    original: Record<string, unknown>,
    repaired: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    if (toolName !== "filesystem") return repaired;

    const next = { ...repaired };
    if (original["allowEmpty"] !== true) delete next["allowEmpty"];

    const action = String(next["action"] ?? original["action"] ?? "").toLowerCase();
    if (action !== "write" && action !== "append") return next;

    const originalContent = extractFileContent(original, String(original["path"] ?? ""));
    const repairedContent = extractFileContent(next, String(next["path"] ?? ""));
    if (originalContent !== repairedContent) {
      this.logger.warn("[SELF-REPAIR] Discarded a repair that altered the file body", {
        toolName,
        originalLength: originalContent?.length ?? null,
        repairedLength: repairedContent?.length ?? null,
      });
      return undefined;
    }
    return next;
  }

  private async attemptSelfRepair(
    toolName: string,
    toolInput: Record<string, unknown>,
    error: string,
    mechanicalHint: string | undefined
  ): Promise<{ toolName: string; input: Record<string, unknown> } | undefined> {
    const mechanicalFix = this.deriveMechanicalRepair(toolName, toolInput);
    if (mechanicalFix) return mechanicalFix;

    const definition = this.executor.getToolDefinitions().find((d) => d.name === toolName);
    if (!definition) return undefined;

    try {
      const messages: LLMMessage[] = [
        {
          role: "system",
          content:
            'You repair a single failed tool call. Given the tool\'s JSON schema, the input that failed, and the error, ' +
            'return ONLY a JSON object of the form {"input": {...corrected parameters...}} using the same tool. ' +
            "Keep every parameter that isn't implicated by the error unchanged. " +
            'If you cannot determine a fix, return {"input": null}.',
        },
        {
          role: "user",
          content: [
            `Tool: ${toolName}`,
            `Schema: ${JSON.stringify(definition.parameters)}`,
            `Failed input: ${JSON.stringify(toolInput)}`,
            `Error: ${error}`,
            mechanicalHint ? `Hint: ${mechanicalHint}` : undefined,
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n"),
        },
      ];

      const response = await this.provider.generate(messages, { temperature: 0, maxTokens: 500 });
      const parsed = this.extractJsonObject(response.content);
      const correctedInput = parsed?.["input"];
      if (!correctedInput || typeof correctedInput !== "object" || Array.isArray(correctedInput)) return undefined;
      if (JSON.stringify(correctedInput) === JSON.stringify(toolInput)) return undefined;

      return { toolName, input: correctedInput as Record<string, unknown> };
    } catch (repairError) {
      this.logger.warn("Self-repair LLM correction failed", {
        toolName,
        error: repairError instanceof Error ? repairError.message : String(repairError),
      });
      return undefined;
    }
  }

  private parseBooleanSetting(raw: string | undefined, fallback: boolean): boolean {
    if (raw === undefined) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
  }

  private parseNumberSetting(raw: string | undefined, fallback: number, min: number, max?: number): number {
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    const bounded = Math.max(min, max !== undefined ? Math.min(max, parsed) : parsed);
    return Math.floor(bounded);
  }

  private parseFloatSetting(raw: string | undefined, fallback: number, min: number, max?: number): number {
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, max !== undefined ? Math.min(max, parsed) : parsed);
  }

  /** Parses a JSON array setting of lowercase slug/name strings - shared by ENABLED_SKILLS and ENABLED_OPTIONAL_TOOLS. */
  private parseSlugListSetting(rawValue: string | undefined): string[] {
    if (!rawValue || rawValue.trim().length === 0) return [];
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0 && /^[a-z0-9_-]+$/.test(item));
    } catch {
      return [];
    }
  }

  private parseSkillBehavior(raw: string | undefined, fallback: "automatic" | "active"): "automatic" | "active" {
    if (!raw) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (normalized === "automatic" || normalized === "auto") return "automatic";
    if (normalized === "active" || normalized === "all_activated") return "active";
    return fallback;
  }

  private async loadRuntimeControls(): Promise<AgentRuntimeControls> {
    const defaults: any = {
      maxIterations: this.maxIterations,
      timeoutMs: this.timeoutMs,
      shellToolTimeoutMs: 120_000,
      httpToolTimeoutMs: 60_000,
      browserToolTimeoutMs: 120_000,
      gitToolTimeoutMs: 120_000,
      qualityPassTimeoutMs: Agent.QUALITY_PASS_TIMEOUT_MS,
      enableAutoMemory: this.enableAutoMemory,
      enableReflection: this.enableReflection,
      reflectionMaxRetries: this.enableReflection ? 1 : 0,
      reflectionStoreMemory: false,
      reflectionMetaReview: false,
      reflectionPostIteration: true,
      reflectionPostIterationMinQuality: "adequate",
      codingMaxIterations: 60,
      codingEnableReflection: false,
      codingEnableVerify: false,
      lightweightMaxIterations: 10,
      chatbotMaxIterations: 5,
      costBudgetUsd: 0,
      costGovernorStop: false,
      autoDowngrade: false,
      enableVerify: false,
      verifyMaxFixAttempts: 1,
      verifyDeriveConstraints: true,
      checklistEnabled: false,
      checklistMinComplexity: "medium",
      // 3 gives the model two genuine repair chances (each failure now injects a concrete
      // repair instruction, so retries are productive rather than blind) before a step is
      // skipped — a better default especially for smaller models that need more tries.
      checklistMaxItemAttempts: 3,
      checklistSkippedPolicy: "soft",
      runJournalEnabled: true,
      enableVision: true,
      reasonerUseToolMinConfidence: 0.65,
      maxConsecutiveToolFailures: this.maxConsecutiveToolFailures,
      maxRepeatedToolCall: this.maxRepeatedToolCall,
      selfRepairEnabled: true,
      // Two, not one: the first attempt is usually the free mechanical fix (a renamed field,
      // a corrected enum), which leaves no budget for the targeted LLM correction when the
      // mechanical guess was not the right one. Self-repair is the main recovery path now, so
      // it gets one real retry. Still bounded, and still capped at 3 by the settings parser.
      /**
       * Output-token ceiling for the main generation call.
       *
       * 8192 was the hard-coded value, and it is what caps how much file a model can emit in one
       * call - a moderately sized HTML page does not fit, so the write arrives truncated. Current
       * Claude models accept up to 128K here and the OpenAI-compatible path passes the number
       * straight through, so 8192 was leaving most of the budget unused. Raised to a value that
       * fits a real file while staying well inside what local runtimes handle; AGENT_MAX_OUTPUT_TOKENS
       * (or the settings page) moves it either way.
       */
      maxOutputTokens: 16384,
      selfRepairMaxAttempts: 2,
      enableAutoSkillSelection: this.enableAutoSkillSelection,
      autoSkillScoreThreshold: this.autoSkillScoreThreshold,
      autoSkillMarginThreshold: this.autoSkillMarginThreshold,
      autoSkillMinInputLength: this.autoSkillMinInputLength,
      autoSkillMinOverlap: this.autoSkillMinOverlap,
      skillBehavior: "automatic",
      autoSkillFallbackNone: true,
      enabledSkillAllowlist: [],
      enabledOptionalTools: [],
      // Provider Settings (NEW)
      providerErrorRetryPolicy: "auto",
      providerErrorMaxRetries: 3,
      providerErrorRetryBackoffMs: 1000,
      providerErrorRetryBackoffMultiplier: 2,
      providerCompressionThreshold: 80,
      providerAutoCompressOnError: true,
      providerCompressionMinChars: 50000,
      providerCredentialRotationStrategy: "auto",
      providerMaxErrorsBeforeRotation: 5,
      providerFailoverEnabled: true,
      providerFailoverStrategy: "intelligent",
      providerMaxErrorsPerProvider: 5,
      providerErrorResetWindowMs: 5 * 60 * 1000,
      providerLogClassifications: false,
      providerLogRetries: true,
      providerLogFailovers: true,
      providerDebugMode: false,
      anthropicTimeoutMs: 30000,
      anthropicMaxRetries: 3,
      anthropicExtendedThinkingEnabled: false,
      anthropicStreamingEnabled: true,
      geminiTimeoutMs: 30000,
      geminiMaxRetries: 3,
      geminiSafetyThreshold: "BLOCK_NONE",
      bedrockTimeoutMs: 30000,
      bedrockMaxRetries: 3,
      bedrockRegion: "us-east-1",
      browserReuseSession: true,
      browserHeadless: true,
      browserViewportWidth: 1440,
      browserViewportHeight: 1024,
      browserExecutablePath: "",
      browserUserAgent: "",
      browserScreenshotFormat: "jpeg",
      browserScreenshotQuality: 85,
      browserDisableImages: false,
      browserBlockResources: "tracking",
      browserHideAutomation: true,
      browserCookieDetection: false,
      browserProxyUrl: "",
    };

    try {
      const rows = await this.db.getAllSettings();
      const map = new Map(rows.map((row) => [row.key, row.value]));
      const get = (key: string): string | undefined => {
        const v = map.get(key);
        return v === null || v === undefined || String(v).trim().length === 0 ? undefined : String(v);
      };

      const result: any = {
        maxIterations: this.parseNumberSetting(get("AGENT_MAX_ITERATIONS"), defaults.maxIterations, 1, 200),
        timeoutMs: this.parseNumberSetting(get("AGENT_TIMEOUT_MS"), defaults.timeoutMs, 5000, 3_600_000),
        shellToolTimeoutMs: this.parseNumberSetting(get("AGENT_TOOL_TIMEOUT_SHELL_MS"), defaults.shellToolTimeoutMs, 1000, 3_600_000),
        httpToolTimeoutMs: this.parseNumberSetting(get("AGENT_TOOL_TIMEOUT_HTTP_MS"), defaults.httpToolTimeoutMs, 1000, 3_600_000),
        browserToolTimeoutMs: this.parseNumberSetting(get("AGENT_TOOL_TIMEOUT_BROWSER_MS"), defaults.browserToolTimeoutMs, 1000, 3_600_000),
        gitToolTimeoutMs: this.parseNumberSetting(get("AGENT_TOOL_TIMEOUT_GIT_MS"), defaults.gitToolTimeoutMs, 1000, 3_600_000),
        qualityPassTimeoutMs: this.parseNumberSetting(get("AGENT_QUALITY_PASS_TIMEOUT_MS"), defaults.qualityPassTimeoutMs, 5000, 600_000),
        enableAutoMemory: this.parseBooleanSetting(get("AGENT_AUTO_MEMORY"), defaults.enableAutoMemory),
        enableReflection: this.parseBooleanSetting(get("AGENT_ENABLE_REFLECTION"), defaults.enableReflection),
        reflectionMaxRetries: this.parseNumberSetting(get("AGENT_REFLECTION_MAX_RETRIES"), defaults.reflectionMaxRetries, 0, 3),
        reflectionStoreMemory: this.parseBooleanSetting(get("AGENT_REFLECTION_STORE_MEMORY"), defaults.reflectionStoreMemory),
        reflectionMetaReview: this.parseBooleanSetting(get("AGENT_REFLECTION_META_REVIEW"), defaults.reflectionMetaReview),
        reflectionPostIteration: this.parseBooleanSetting(get("AGENT_REFLECTION_POST_ITERATION"), defaults.reflectionPostIteration),
        reflectionPostIterationMinQuality: (get("AGENT_REFLECTION_POST_ITERATION_MIN_QUALITY") ?? defaults.reflectionPostIterationMinQuality) as "poor" | "adequate" | "good" | "excellent",
        costBudgetUsd: this.parseFloatSetting(get("AGENT_COST_BUDGET_USD"), defaults.costBudgetUsd, 0, 1000),
        costGovernorStop: this.parseBooleanSetting(get("AGENT_COST_GOVERNOR_STOP"), defaults.costGovernorStop),
        autoDowngrade: this.parseBooleanSetting(get("AGENT_AUTO_DOWNGRADE"), defaults.autoDowngrade),
        codingMaxIterations: this.parseNumberSetting(get("AGENT_CODING_MAX_ITERATIONS"), defaults.codingMaxIterations, 1, 300),
        codingEnableReflection: this.parseBooleanSetting(get("AGENT_CODING_ENABLE_REFLECTION"), defaults.codingEnableReflection),
        codingEnableVerify: this.parseBooleanSetting(get("AGENT_CODING_ENABLE_VERIFY"), defaults.codingEnableVerify),
        lightweightMaxIterations: this.parseNumberSetting(get("AGENT_LIGHTWEIGHT_MAX_ITERATIONS"), defaults.lightweightMaxIterations, 1, 50),
        chatbotMaxIterations: this.parseNumberSetting(get("AGENT_CHATBOT_MAX_ITERATIONS"), defaults.chatbotMaxIterations, 1, 50),
        enableVerify: this.parseBooleanSetting(get("AGENT_ENABLE_VERIFY"), defaults.enableVerify),
        verifyMaxFixAttempts: this.parseNumberSetting(get("AGENT_VERIFY_MAX_FIX_ATTEMPTS"), defaults.verifyMaxFixAttempts, 0, 3),
        verifyDeriveConstraints: this.parseBooleanSetting(get("AGENT_VERIFY_DERIVE_CONSTRAINTS"), defaults.verifyDeriveConstraints),
        checklistEnabled: this.parseBooleanSetting(get("AGENT_CHECKLIST_ENABLED"), defaults.checklistEnabled),
        checklistMinComplexity: ((): "low" | "medium" | "high" => {
          const raw = (get("AGENT_CHECKLIST_MIN_COMPLEXITY") ?? "").toLowerCase();
          return raw === "low" || raw === "high" ? raw : defaults.checklistMinComplexity;
        })(),
        checklistMaxItemAttempts: this.parseNumberSetting(get("AGENT_CHECKLIST_MAX_ITEM_ATTEMPTS"), defaults.checklistMaxItemAttempts, 1, 5),
        checklistSkippedPolicy: (get("AGENT_CHECKLIST_SKIPPED_POLICY") ?? "").toLowerCase() === "strict" ? "strict" : defaults.checklistSkippedPolicy,
        runJournalEnabled: this.parseBooleanSetting(get("AGENT_RUN_JOURNAL_ENABLED"), defaults.runJournalEnabled),
        enableVision: this.parseBooleanSetting(get("AGENT_ENABLE_VISION"), defaults.enableVision),
        reasonerUseToolMinConfidence: this.parseFloatSetting(get("AGENT_REASONER_USE_TOOL_MIN_CONFIDENCE"), defaults.reasonerUseToolMinConfidence, 0, 1),
        maxConsecutiveToolFailures: this.parseNumberSetting(get("AGENT_MAX_TOOL_FAILURES"), defaults.maxConsecutiveToolFailures, 1, 20),
        maxRepeatedToolCall: this.parseNumberSetting(get("AGENT_MAX_REPEATED_TOOL_CALL"), defaults.maxRepeatedToolCall, 1, 20),
        selfRepairEnabled: this.parseBooleanSetting(get("AGENT_SELF_REPAIR"), defaults.selfRepairEnabled),
        maxOutputTokens: this.parseNumberSetting(get("AGENT_MAX_OUTPUT_TOKENS"), defaults.maxOutputTokens, 512, 128000),
        selfRepairMaxAttempts: this.parseNumberSetting(get("AGENT_SELF_REPAIR_MAX_ATTEMPTS"), defaults.selfRepairMaxAttempts, 0, 3),
        enableAutoSkillSelection: this.parseBooleanSetting(get("AGENT_AUTO_SKILL_SELECTION"), defaults.enableAutoSkillSelection),
        autoSkillScoreThreshold: this.parseFloatSetting(get("AGENT_AUTO_SKILL_THRESHOLD"), defaults.autoSkillScoreThreshold, 0, 1),
        autoSkillMarginThreshold: this.parseFloatSetting(get("AGENT_AUTO_SKILL_MARGIN"), defaults.autoSkillMarginThreshold, 0, 1),
        autoSkillMinInputLength: this.parseNumberSetting(get("AGENT_AUTO_SKILL_MIN_INPUT_LEN"), defaults.autoSkillMinInputLength, 1, 2000),
        autoSkillMinOverlap: this.parseNumberSetting(get("AGENT_AUTO_SKILL_MIN_OVERLAP"), defaults.autoSkillMinOverlap, 0, 20),
        skillBehavior: this.parseSkillBehavior(get("AGENT_SKILL_BEHAVIOR"), defaults.skillBehavior),
        autoSkillFallbackNone: this.parseBooleanSetting(get("AGENT_AUTO_SKILL_FALLBACK_NONE"), defaults.autoSkillFallbackNone),
        enabledSkillAllowlist: this.parseSlugListSetting(get("ENABLED_SKILLS")),
        enabledOptionalTools: this.parseSlugListSetting(get("ENABLED_OPTIONAL_TOOLS")),
        alwaysLoadSkills: this.parseSlugListSetting(get("ALWAYS_LOAD_SKILLS")),
        // Provider Settings (NEW)
        providerErrorRetryPolicy: (get("AGENT_PROVIDER_ERROR_RETRY_POLICY") ?? defaults.providerErrorRetryPolicy) as any,
        providerErrorMaxRetries: this.parseNumberSetting(get("AGENT_PROVIDER_ERROR_MAX_RETRIES"), defaults.providerErrorMaxRetries, 1, 10),
        providerErrorRetryBackoffMs: this.parseNumberSetting(get("AGENT_PROVIDER_ERROR_RETRY_BACKOFF_MS"), defaults.providerErrorRetryBackoffMs, 100, 30000),
        providerErrorRetryBackoffMultiplier: this.parseFloatSetting(get("AGENT_PROVIDER_ERROR_RETRY_BACKOFF_MULTIPLIER"), defaults.providerErrorRetryBackoffMultiplier, 1, 5),
        providerCompressionThreshold: this.parseNumberSetting(get("AGENT_PROVIDER_COMPRESSION_THRESHOLD"), defaults.providerCompressionThreshold, 50, 99),
        providerAutoCompressOnError: this.parseBooleanSetting(get("AGENT_PROVIDER_AUTO_COMPRESS_ON_ERROR"), defaults.providerAutoCompressOnError),
        providerCompressionMinChars: this.parseNumberSetting(get("AGENT_PROVIDER_COMPRESSION_MIN_CHARS"), defaults.providerCompressionMinChars, 1000, 1000000),
        providerCredentialRotationStrategy: (get("AGENT_PROVIDER_CREDENTIAL_ROTATION_STRATEGY") ?? defaults.providerCredentialRotationStrategy) as any,
        providerMaxErrorsBeforeRotation: this.parseNumberSetting(get("AGENT_PROVIDER_MAX_ERRORS_BEFORE_ROTATION"), defaults.providerMaxErrorsBeforeRotation, 1, 100),
        providerFailoverEnabled: this.parseBooleanSetting(get("AGENT_PROVIDER_FAILOVER_ENABLED"), defaults.providerFailoverEnabled),
        providerFailoverStrategy: (get("AGENT_PROVIDER_FAILOVER_STRATEGY") ?? defaults.providerFailoverStrategy) as any,
        providerMaxErrorsPerProvider: this.parseNumberSetting(get("AGENT_PROVIDER_MAX_ERRORS_PER_PROVIDER"), defaults.providerMaxErrorsPerProvider, 1, 100),
        providerErrorResetWindowMs: this.parseNumberSetting(get("AGENT_PROVIDER_ERROR_RESET_WINDOW_MS"), defaults.providerErrorResetWindowMs, 60000, 3600000),
        providerLogClassifications: this.parseBooleanSetting(get("AGENT_PROVIDER_LOG_CLASSIFICATIONS"), defaults.providerLogClassifications),
        providerLogRetries: this.parseBooleanSetting(get("AGENT_PROVIDER_LOG_RETRIES"), defaults.providerLogRetries),
        providerLogFailovers: this.parseBooleanSetting(get("AGENT_PROVIDER_LOG_FAILOVERS"), defaults.providerLogFailovers),
        providerDebugMode: this.parseBooleanSetting(get("AGENT_PROVIDER_DEBUG_MODE"), defaults.providerDebugMode),
        anthropicTimeoutMs: this.parseNumberSetting(get("AGENT_ANTHROPIC_TIMEOUT_MS"), defaults.anthropicTimeoutMs, 5000, 600000),
        anthropicMaxRetries: this.parseNumberSetting(get("AGENT_ANTHROPIC_MAX_RETRIES"), defaults.anthropicMaxRetries, 0, 10),
        anthropicExtendedThinkingEnabled: this.parseBooleanSetting(get("AGENT_ANTHROPIC_EXTENDED_THINKING"), defaults.anthropicExtendedThinkingEnabled),
        anthropicStreamingEnabled: this.parseBooleanSetting(get("AGENT_ANTHROPIC_STREAMING"), defaults.anthropicStreamingEnabled),
        geminiTimeoutMs: this.parseNumberSetting(get("AGENT_GEMINI_TIMEOUT_MS"), defaults.geminiTimeoutMs, 5000, 600000),
        geminiMaxRetries: this.parseNumberSetting(get("AGENT_GEMINI_MAX_RETRIES"), defaults.geminiMaxRetries, 0, 10),
        geminiSafetyThreshold: (get("AGENT_GEMINI_SAFETY_THRESHOLD") ?? defaults.geminiSafetyThreshold) as any,
        bedrockTimeoutMs: this.parseNumberSetting(get("AGENT_BEDROCK_TIMEOUT_MS"), defaults.bedrockTimeoutMs, 5000, 600000),
        bedrockMaxRetries: this.parseNumberSetting(get("AGENT_BEDROCK_MAX_RETRIES"), defaults.bedrockMaxRetries, 0, 10),
        bedrockRegion: (get("AGENT_BEDROCK_REGION") ?? defaults.bedrockRegion) as any,
        browserReuseSession: this.parseBooleanSetting(get("BROWSER_REUSE_SESSION"), defaults.browserReuseSession),
        browserHeadless: this.parseBooleanSetting(get("BROWSER_HEADLESS_MODE"), defaults.browserHeadless),
        browserViewportWidth: this.parseNumberSetting(get("BROWSER_VIEWPORT_WIDTH"), defaults.browserViewportWidth, 320, 3840),
        browserViewportHeight: this.parseNumberSetting(get("BROWSER_VIEWPORT_HEIGHT"), defaults.browserViewportHeight, 240, 2160),
        browserExecutablePath: get("BROWSER_CUSTOM_EXECUTABLE_PATH") ?? defaults.browserExecutablePath,
        browserUserAgent: get("BROWSER_USER_AGENT") ?? defaults.browserUserAgent,
        browserScreenshotFormat: (get("BROWSER_SCREENSHOT_FORMAT") ?? defaults.browserScreenshotFormat) as "jpeg" | "png" | "webp",
        browserScreenshotQuality: this.parseNumberSetting(get("BROWSER_SCREENSHOT_QUALITY"), defaults.browserScreenshotQuality, 1, 100),
        browserDisableImages: this.parseBooleanSetting(get("BROWSER_DISABLE_IMAGES"), defaults.browserDisableImages),
        browserBlockResources: (get("BROWSER_BLOCK_RESOURCES") ?? defaults.browserBlockResources) as "none" | "tracking" | "ads" | "all",
        browserHideAutomation: this.parseBooleanSetting(get("BROWSER_DISABLE_AUTOMATION"), defaults.browserHideAutomation),
        browserCookieDetection: this.parseBooleanSetting(get("BROWSER_COOKIE_DETECTION"), defaults.browserCookieDetection),
        browserProxyUrl: get("BROWSER_PROXY_URL") ?? defaults.browserProxyUrl,
      };
      return result;
    } catch {
      return defaults;
    }
  }

  /**
   * agentMode:"plan" implementation - creates a structured plan via the Planner and
   * returns it as the full response, persisting both turns to conversation history like
   * a normal run would, but never entering the tool-execution loop. This is the
   * whole-turn version of the standalone "plan" tool (plan-tool.ts); both share
   * formatPlanAsMarkdown so a plan reads the same regardless of which path produced it.
   */
  private async compressImageBuffer(buffer: Buffer, maxSizeBytes: number = 150000): Promise<Buffer> {
    // Enforce conservative 150KB limit for LLM providers (actual limit is 200KB but stay safe)
    let result = buffer;

    // Try to use sharp library if available for real compression
    try {
      // @ts-expect-error sharp is an optional dependency
      const sharp = (await import("sharp")).default;
      if (sharp) {
        // Compress with progressive quality reduction if needed
        result = await sharp(buffer)
          .jpeg({ quality: 80 })
          .toBuffer();

        // If still too large, reduce quality further
        if (result.length > maxSizeBytes) {
          result = await sharp(buffer)
            .jpeg({ quality: 60 })
            .toBuffer();
        }

        // Last resort: ultra-low quality
        if (result.length > maxSizeBytes) {
          result = await sharp(buffer)
            .jpeg({ quality: 40 })
            .toBuffer();
        }

        const ratio = ((1 - result.length / buffer.length) * 100).toFixed(1);
        this.logger.info("Image compressed with sharp", {
          originalSize: buffer.length,
          compressedSize: result.length,
          compressionRatio: `${ratio}%`,
          exceedsLimit: result.length > maxSizeBytes,
        });

        return result;
      }
    } catch (sharpError) {
      // Sharp not available, fallback to simple size check
      this.logger.debug("Sharp library not available for image compression", {
        error: sharpError instanceof Error ? sharpError.message : String(sharpError),
      });
    }

    // Fallback: Log if image exceeds limit
    if (buffer.length > maxSizeBytes) {
      this.logger.warn("Image exceeds LLM provider size limit", {
        size: Math.round(buffer.length / 1024),
        limit: Math.round(maxSizeBytes / 1024),
        recommendation: "Install sharp library for compression: npm install sharp",
      });
    }

    return result;
  }

  async createImageMessage(imageBuffer: Buffer, mimeType: string = "image/png", description: string = ""): Promise<LLMMessage> {
    const buffer = await this.compressImageBuffer(imageBuffer);
    const base64Url = `data:${mimeType};base64,${buffer.toString("base64")}`;

    const imageContent: LLMContent[] = [
      { type: "image_data", image_data: { url: base64Url, mime_type: mimeType } },
    ];

    if (description) {
      imageContent.push({ type: "text", text: description });
    }

    return {
      role: "user",
      content: imageContent,
      metadata: { source: "image_attachment" },
    };
  }

  async createImageUrlMessage(imageUrl: string, description: string = ""): Promise<LLMMessage> {
    const imageContent: LLMContent[] = [
      { type: "image_url", image_url: { url: imageUrl, detail: "auto" } },
    ];

    if (description) {
      imageContent.push({ type: "text", text: description });
    }

    return {
      role: "user",
      content: imageContent,
      metadata: { source: "image_url" },
    };
  }

  private async executePreFlightTools(userInput: string, options: AgentRunOptions): Promise<void> {
    // BEST PRACTICE: Execute real-time data tools BEFORE LLM inference to prevent hallucination
    // This ensures the agent has ground truth before reasoning

    // Detect queries needing current date/time
    const dateTimePattern = /\b(current|today|what is the|what time)?\s*(date|time|now|today's date)\b/i;
    const needsDateTime = dateTimePattern.test(userInput);

    if (needsDateTime) {
      try {
        // Execute 'date' command automatically for time queries
        // Use the executor which handles tool invocation properly
        const dateResult = await this.executor.execute("shell", { command: "date" });

        if (dateResult) {
          // Handle different result formats from executor
          let dateOutput = "";

          if (typeof dateResult === "string") {
            dateOutput = dateResult;
          } else if (typeof dateResult === "object") {
            const result = dateResult as any;
            // Executor returns {output, exitCode, shell} for shell commands
            if (result.output && typeof result.output === "string") {
              dateOutput = result.output;
            } else if (result.data && typeof result.data === "string") {
              dateOutput = result.data;
            } else if (result.stdout && typeof result.stdout === "string") {
              dateOutput = result.stdout;
            } else if (result.result && typeof result.result === "string") {
              dateOutput = result.result;
            } else if (result.success === true && result.data) {
              // If it's a ToolResult object with success flag
              dateOutput = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
            }
          }

          if (dateOutput.trim()) {
            // Add the date/time result to conversation BEFORE LLM sees it
            const dateMessage: LLMMessage = {
              role: "system",
              content: `GROUND TRUTH - CURRENT SYSTEM DATE/TIME (executed before reasoning):\n${dateOutput.trim()}`,
            };
            await this.conversation.addMessage(dateMessage);

            this.logger.info("[PRE-FLIGHT] Injected current date/time before LLM inference", {
              output: dateOutput,
              query: userInput,
            });
          }
        }
      } catch (error) {
        this.logger.warn("[PRE-FLIGHT] Failed to execute date tool", {
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't fail the agent - just continue without the ground truth
      }
    }
  }

  /** Both the built-in `browser` tool and the `browser-control` MCP tool produce screenshots
   *  in the same result shape; the chat preview + vision-analysis paths must treat them alike
   *  (otherwise a screenshot from browser-control is shown as raw JSON and never reaches the
   *  vision model, so it "sees" nothing). */
  private isBrowserTool(toolName: string | undefined): boolean {
    const n = (toolName ?? "").trim().toLowerCase();
    return n === "browser" || n === "browser-control" || n === "browser_control";
  }

  private async handleScreenshotCapture(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResult: ToolResult
  ): Promise<void> {
    if (!toolResult.success || !this.isBrowserTool(toolName)) return;

    // Screenshots arrive on many browser actions (navigate/click/type/wait), not only
    // action:"screenshot" - the browser tool embeds the image in the result and the UI preview
    // already renders it. Gating on action:"screenshot" here meant those images were shown to the
    // user but NEVER handed to the vision model, so the LLM analyzed a page it could not see. Gate
    // instead on the presence of actual screenshot DATA below (screenshotUrl/screenshot/savedTo);
    // actions without an image fall through to the `if (!buffer) return` guard and cost nothing.
    const data = toolResult.data as Record<string, unknown> | undefined;
    if (!data) return;

    let buffer: Buffer | undefined;

    // Try multiple approaches to extract screenshot data
    if (Buffer.isBuffer(data)) {
      // Legacy: direct buffer (for backwards compatibility)
      buffer = data;
    } else if (typeof data.screenshotUrl === "string" && data.screenshotUrl.length > 0) {
      // New format: Screenshot stored in server storage (from browser tool)
      // Fetch the image and convert to data: URL so Ollama provider can extract base64
      let imageDataUrl: string | undefined;
      let fetchedBuffer: Buffer | undefined;

      try {
        // Build absolute URL if relative
        let screenUrl = data.screenshotUrl;
        if (!screenUrl.startsWith("http://") && !screenUrl.startsWith("https://")) {
          const baseUrl = process.env["SERVER_BASE_URL"] || `http://localhost:${process.env["SERVER_PORT"] || 3000}`;
          screenUrl = `${baseUrl}${screenUrl}`;
        }

        this.logger.debug("Fetching screenshot from URL", { screenUrl });
        const response = await fetch(screenUrl);

        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          fetchedBuffer = Buffer.from(arrayBuffer);
          const mimeType = response.headers.get("content-type") || "image/png";
          imageDataUrl = `data:${mimeType};base64,${fetchedBuffer.toString("base64")}`;

          this.logger.debug("Screenshot fetched and converted to data URL", {
            url: data.screenshotUrl,
            size: fetchedBuffer.length,
            mimeType,
          });
        } else {
          this.logger.warn("Failed to fetch screenshot - non-OK response", {
            url: screenUrl,
            status: response.status,
            statusText: response.statusText,
          });
        }
      } catch (error) {
        this.logger.warn("Failed to fetch screenshot image from URL", {
          url: data.screenshotUrl,
          error: error instanceof Error ? error.message : String(error),
          note: "Will use relative URL as fallback - may not work with vision models",
        });
      }

      const analysisText = `Screenshot from: ${data.screenshotUrl}\n\nAnalyze this screenshot and describe:\n1. Page content and what you see\n2. Key text, buttons, and interactive elements\n3. Visual layout and design\n4. Any errors or status indicators\n5. Current state relative to expected result`;

      const imageContent: LLMContent[] = [
        {
          type: "text",
          text: analysisText
        },
        {
          type: "image_url",
          image_url: {
            url: imageDataUrl || data.screenshotUrl,
            detail: "high"
          }
        }
      ];

      const screenshotMessage: LLMMessage = {
        role: "user",
        content: imageContent,
        metadata: {
          source: "browser_screenshot",
          url: data.screenshotUrl,
          storedId: data.screenshotId,
          hasDataUrl: !!imageDataUrl,
        },
      };

      this.currentScreenshotMessage = screenshotMessage;
      this.history.add(screenshotMessage, "screenshot");

      this.logger.info("Screenshot message prepared for vision model", {
        url: data.screenshotUrl,
        hasDataUrl: !!imageDataUrl,
        imageSize: fetchedBuffer?.length,
        id: data.screenshotId,
        provider: this.provider.name,
      });
      return;
    } else if (typeof data.screenshot === "string" && data.screenshot.length > 0) {
      // New format: base64-encoded string in 'screenshot' field (from browser tool)
      try {
        buffer = Buffer.from(data.screenshot, "base64");
      } catch (error) {
        this.logger.warn("Failed to decode base64 screenshot", { error: error instanceof Error ? error.message : String(error) });
        return;
      }
    } else if (typeof data.savedTo === "string" && data.savedTo.length > 0) {
      // File path: try to read from disk
      try {
        if (existsSync(data.savedTo)) {
          buffer = readFileSync(data.savedTo);
        }
      } catch (error) {
        this.logger.warn("Failed to read screenshot file", { path: data.savedTo, error: error instanceof Error ? error.message : String(error) });
        return;
      }
    }

    if (!buffer) return;

    // Compress image for efficiency (WebP is already compressed)
    buffer = await this.compressImageBuffer(buffer);

    // Enforce strict LLM provider limit (200KB is the actual limit, not Database limit)
    const MAX_IMAGE_SIZE = 150000; // 150KB - be conservative to stay under 200KB limit
    if (buffer.length > MAX_IMAGE_SIZE) {
      this.logger.warn("Screenshot exceeds LLM provider size limit after compression", {
        size: buffer.length,
        max: MAX_IMAGE_SIZE,
        recommendation: "Image should have been stored in screenshot storage instead",
      });
      // Skip sending this oversized image - better to skip than crash LLM call
      return;
    }

    const url = (data.url as string) ?? "(unknown)";
    const base64String = buffer.toString("base64");

    // Clear old screenshots from history before adding new one (Fix #3: Multiple screenshot handling)
    this.history.clearByType("screenshot");

    // Generate context-aware analysis prompt based on browser action (Fix #2: Context-aware prompts)
    const toolAction = toolInput.action as string;
    let analysisText = `Screenshot captured from: ${url}\n\nAnalyze this screenshot and describe:\n1. Page content and what you see\n2. Key text, buttons, and interactive elements\n3. Visual layout and design\n4. Any errors or status indicators\n5. Current state relative to expected result`;

    if (toolAction === "click") {
      analysisText = `Screenshot after clicking.\nVerify the click worked:\n1. Did the page change?\n2. Are there new elements or changes?\n3. Any error messages or unexpected behavior?`;
    } else if (toolAction === "type") {
      analysisText = `Screenshot after typing.\nVerify text input:\n1. Is text in the correct field?\n2. Is cursor/focus visible?\n3. Any validation feedback or errors?`;
    } else if (toolAction === "navigate") {
      analysisText = `Screenshot after navigation to ${url}.\nVerify page load:\n1. Did page load successfully?\n2. Are main elements visible?\n3. Any error/loading states?\n4. Is content as expected?`;
    } else if (toolAction === "wait") {
      analysisText = `Screenshot after waiting.\nCheck expected element appearance:\n1. Did the expected element appear?\n2. Page state vs expected?\n3. Is page ready for next action?`;
    }

    // Use standard LLMContent[] format for ALL providers
    // Each provider implementation handles conversion to its own API format:
    // - OpenAI/Claude: uses content array directly
    // - Ollama: converts image_url to separate images field
    // Text first, image second: matches the request shape confirmed to work against local
    // Qwen-VL vision endpoints (some servers are picky about part ordering).
    const imageContent: LLMContent[] = [
      {
        type: "text",
        text: analysisText
      },
      {
        type: "image_url",
        // compressImageBuffer() always re-encodes as jpeg via sharp when available -
        // webp was silently unreadable by common local vision backends (llama.cpp/GGUF
        // loaders use stb_image, which has no webp decoder).
        image_url: { url: `data:image/jpeg;base64,${base64String}`, detail: "high" }
      }
    ];

    // Calculate estimated tokens (Fix #4: Token counting)
    const estimatedTokens = Math.round(base64String.length / 500); // Rough estimate: 500 chars ≈ 1 token

    const screenshotMessage: LLMMessage = {
      role: "user",
      content: imageContent,
      metadata: {
        source: "browser_screenshot",
        url,
        estimatedTokens,
        format: "jpeg",
        size: buffer.length,
      },
    };

    // Store screenshot message to be added at each iteration
    // Don't persist to DB - vision messages are ephemeral but need to persist across iterations
    this.currentScreenshotMessage = screenshotMessage;
    this.history.add(screenshotMessage, "screenshot");

    this.logger.info("Screenshot vision message stored", {
      estimatedTokens,
      size: buffer.length,
      action: toolAction,
    });

    this.logger.info("Screenshot vision message stored for iterations", {
      base64Size: base64String.length,
      bufferSize: buffer.length,
      url,
      provider: this.provider.name,
    });
  }

  private async runPlanMode(
    userInput: string,
    options: AgentRunOptions,
    emit: (type: AgentRunEventType, message: string, data?: Record<string, unknown>) => void
  ): Promise<AgentRunResult> {
    const metadata: Record<string, unknown> = {};
    if (options.attachments?.length) {
      metadata.attachments = options.attachments;
    }
    if (options.localMessageId) {
      metadata.localMessageId = options.localMessageId;
    }
    const userMessage: LLMMessage = {
      role: "user",
      content: userInput,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
    await this.conversation.addMessage(userMessage);
    this.history.add(userMessage);

    emit("plan", "Erstelle Plan...", { source: "plan_mode", phase: "start", goal: userInput });

    const availableToolNames = this.executor.listTools().map((tool) => tool.name);
    const plan = await this.planner.createPlan(userInput, availableToolNames, {
      currentModel: this.provider.model,
    });
    const response = formatPlanAsMarkdown(plan);

    if (options.stream && options.onChunk) {
      options.onChunk(response);
    }

    const assistantMetadata: Record<string, unknown> = {};
    if (options.localMessageId) {
      assistantMetadata.localMessageId = options.localMessageId;
    }
    const assistantMessage: LLMMessage = {
      role: "assistant",
      content: response,
      metadata: Object.keys(assistantMetadata).length > 0 ? assistantMetadata : undefined,
    };
    await this.conversation.addMessage(assistantMessage);
    this.history.add(assistantMessage);

    // Emit the full structured plan (not just a step count): the UI's plan panel renders
    // and executes from this payload, so anything missing here would have to be recovered
    // by re-parsing the markdown.
    emit("plan", "Plan erstellt", { ...toPlanEventPayload(plan, response), phase: "done" });

    // PLAN_MODE_AUTO_SAVE: persist the plan as a markdown file under
    // shared-workspace/<PLAN_MODE_MARKDOWN_PATH> so it survives outside the conversation
    // and can be inspected/edited directly. Default on; failures are logged but never
    // fail the plan-creation turn itself.
    try {
      const autoSaveSetting = await this.db.getSetting("PLAN_MODE_AUTO_SAVE");
      const autoSaveEnabled = autoSaveSetting === undefined || autoSaveSetting.toLowerCase() !== "false";
      if (autoSaveEnabled) {
        const markdownDir = (await this.db.getSetting("PLAN_MODE_MARKDOWN_PATH"))?.trim() || "plans";
        const slug =
          plan.goal
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "plan";
        const savePath = `${markdownDir}/${slug}-${Date.now()}.md`;
        const writeResult = await this.executor.execute("filesystem", {
          action: "write",
          path: savePath,
          content: response,
        });
        if (writeResult.success) {
          emit("guardrail", `Plan gespeichert: ${savePath}`, { path: savePath });
        } else {
          this.logger.warn("Failed to auto-save plan markdown", { path: savePath, error: writeResult.error });
        }
      }
    } catch (error) {
      this.logger.warn("Failed to auto-save plan markdown", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      response,
      iterations: 1,
      toolsUsed: [],
      conversationId: this.conversation.id,
    };
  }

  private async executeToolCallsFromResponse(
    response: string,
    controls: AgentRuntimeControls,
    options: AgentRunOptions,
    emit: (type: AgentRunEventType, message: string, data?: Record<string, unknown>) => void,
    iterations: number,
    repeatedToolCalls: Map<string, number>,
    nativeToolCalls?: ToolCall[],
    /** True when the model hit its output cap - see the write guard below. */
    responseWasTruncated = false
  ): Promise<{ resultMap: Map<string, ToolResult>; cleanedResponse: string; browserToolsCount: number; journalEntries: RunJournalEntry[] }> {
    this.logger.info("[TOOL-CALLS] Starting extraction and execution", {
      responseLength: response.length,
      hasToolMarkers: /\[TOOL:/.test(response),
      nativeCallCount: nativeToolCalls?.length ?? 0,
    });

    // Shared by every tool_call/tool_result/browser_preview event below so the UI can
    // fold all tool calls issued by this single LLM response into one collapsible group.
    const toolBatchId = randomUUID();

    // Prefer NATIVE (structured) tool calls when the provider returned them: the model
    // never hand-serialized the call into prose, so there is nothing to leak or mis-parse.
    // The text `[TOOL:...]` parser ALSO always runs on the accompanying response text and is
    // merged in, rather than being skipped whenever native calls are present - some local
    // models (e.g. gpt-oss) emit a bare native call (action/path only, no content) AND
    // separately write the actual file content as a `[TOOL:filesystem ...]` heredoc block in
    // the same response, apparently trying to satisfy both conventions at once. Treating
    // native-present as exclusive silently dropped that heredoc block and the write failed
    // with "Content required". Merging picks up whichever form actually carried the content.
    const nativeExtract = nativeToolCalls && nativeToolCalls.length > 0
      ? this.nativeToolCallsToExtractResult(nativeToolCalls)
      : undefined;
    const textExtract = this.extractAllToolCalls(response);
    const extractResult = nativeExtract
      ? {
          calls: [...nativeExtract.calls, ...textExtract.calls],
          markerCount: nativeExtract.markerCount + textExtract.markerCount,
          unparsed: [...nativeExtract.unparsed, ...textExtract.unparsed],
        }
      : textExtract;
    let toolCalls = extractResult.calls;

    // Deduplicate tool calls: if same action is called twice in a row, keep only first
    const deduplicatedCalls: typeof toolCalls = [];
    const callSignatures = new Set<string>();
    for (const call of toolCalls) {
      const signature = `${call.toolName}:${JSON.stringify(call.input)}`;
      if (!callSignatures.has(signature)) {
        deduplicatedCalls.push(call);
        callSignatures.add(signature);
      } else {
        this.logger.warn("[TOOL-CALLS] Deduplicating repeated tool call", {
          toolName: call.toolName,
          input: call.input,
        });
      }
    }
    toolCalls = deduplicatedCalls;

    // Count browser launch vs other browser calls
    const browserLaunches = extractResult.calls.filter(c => c.toolName === "browser" && c.input["action"] === "launch").length;
    const otherBrowserCalls = extractResult.calls.filter(c => c.toolName === "browser" && c.input["action"] !== "launch").length;

    this.logger.info("[TOOL-CALLS] Extraction complete", {
      responsePreview: response.slice(0, 300),
      markerCount: extractResult.markerCount,
      extractedCount: extractResult.calls.length,
      browserLaunches,
      otherBrowserCalls,
      dedupCount: toolCalls.length,
      unparsedCount: extractResult.unparsed.length,
      toolNames: toolCalls.map((c) => c.toolName),
      allToolDetails: extractResult.calls.map(c => ({ toolName: c.toolName, action: c.input["action"], hasSessionId: !!c.input["sessionId"] })),
      deduplicatedCount: extractResult.calls.length - toolCalls.length,
    });

    // Only trigger guardrail if we found markers but couldn't parse ANY of them.
    // If we successfully parsed some calls despite unparsed markers, let them execute.
    if (extractResult.unparsed.length > 0 && toolCalls.length === 0) {
      this.logger.warn("[TOOL-CALLS] Unparsed tool call markers detected with no successful parses", {
        unparsed: extractResult.unparsed.slice(0, 5),
      });
      emit("guardrail", "Unable to parse any tool calls from response", {
        markerCount: extractResult.markerCount,
        parsed: toolCalls.length,
        unparsed: extractResult.unparsed,
      });
    } else if (extractResult.unparsed.length > 0 && toolCalls.length > 0) {
      // Log partial parse success (some calls were extracted, some weren't) at debug level
      this.logger.debug("[TOOL-CALLS] Partial parse success: extracted some calls despite unparsed markers", {
        parsed: toolCalls.length,
        unparsed: extractResult.unparsed.length,
        proceeding: true,
      });
    }

    const resultMap = new Map<string, ToolResult>();
    const journalEntries: RunJournalEntry[] = [];

    if (toolCalls.length === 0) {
      this.logger.info("[TOOL-CALLS] No tool calls found, skipping execution");
      // Still clean the response to remove any markers (even if unparsed)
      const cleanedResponse = response
        .replace(/\[TOOL:[A-Za-z_][A-Za-z0-9_\-]*[^\]\n(){}]*\]\r?\n[\s\S]*?\r?\n?\[\/TOOL\]/g, "") // Remove heredoc write blocks
        .replace(/\[\/TOOL\]/g, "")                           // Remove any stray heredoc terminators
        .replace(/\[TOOL:[^\]]*\]/g, "")                     // Remove [TOOL:...] markers
        .replace(/<\|channel>.*?<channel\|>/gs, "")          // Remove <|channel>...<channel|> blocks
        .replace(/<\|channel>thought[^\n]*\n?/g, "")         // Remove <|channel>thought markers
        .replace(/<channel\|>/g, "")                          // Remove <channel|> end markers
        .replace(/<\|tool_call>.*?<tool_call\|>/gs, "")      // Remove <|tool_call>...<tool_call|> blocks
        .replace(/<\|[a-zA-Z_]+>/g, "")                       // Remove other <|...> markers
        .trim();
      return { resultMap, cleanedResponse, browserToolsCount: 0, journalEntries };
    }

    // Emit initial tool-call detection event
    const callSummaries = toolCalls.map((c) => summarizeToolCall(c.toolName, c.input));
    // Per-call ids MUST match the ones the tool_result events will carry so the UI can
    // correlate start->completion. buildExecutionPlan below assigns `batch_${iterations}_${idx}`
    // (idx = position in this deduped toolCalls list), so mint the same ids here. Without this
    // the store synthesised a timestamp-based id that never matched the batch id, and the
    // completion event logged "Tool call not found" (seen in the coding agent, whose calls
    // weren't already resolved by the toolName fallback).
    const callIds = toolCalls.map((_, idx) => `batch_${iterations}_${idx}`);
    emit("tool_call", callSummaries.join(" · "), {
      toolBatchId,
      batchSize: toolCalls.length,
      count: toolCalls.length,
      tools: toolCalls.map((c) => c.toolName),
      callIds,
      // summary carries what the reader actually needs (which file, which command); the
      // input keys stay available underneath for debugging.
      summaries: callSummaries,
      toolDetails: toolCalls.map((c, index) => ({
        toolName: c.toolName,
        summary: callSummaries[index],
        inputKeys: Object.keys(c.input),
        callId: callIds[index],
      })),
    });

    // Build execution plan respecting dependencies
    this.logger.info("[TOOL-CALLS] Building execution plan", { count: toolCalls.length });

    const executionBatches = this.toolGraph.buildExecutionPlan(
      toolCalls.map((call, idx) => ({
        toolName: call.toolName,
        input: call.input,
        id: `batch_${iterations}_${idx}`,
      }))
    );

    this.logger.info("[TOOL-CALLS] Execution plan built", {
      batchCount: executionBatches.length,
      batchSizes: executionBatches.map((b) => b.length),
    });

    // Execute each batch (respecting tool dependencies)
    for (let batchIdx = 0; batchIdx < executionBatches.length; batchIdx++) {
      const batch = executionBatches[batchIdx];
      if (!batch) {
        this.logger.warn("[TOOL-CALLS] Batch is undefined, skipping", { batchIdx });
        continue;
      }

      this.logger.info(`[TOOL-CALLS] Executing batch ${batchIdx + 1}/${executionBatches.length}`, {
        batchSize: batch.length,
        tools: batch.map((c) => c.toolName),
      });

      const validCalls: Array<{ id: string; toolName: string; input: Record<string, unknown> }> = [];
      const batchValidationStart = Date.now();

      // Validate and preprocess calls
      for (const call of batch) {
        const callId = call.id ?? `${call.toolName}_${JSON.stringify(call.input)}`;
        const signature = this.buildToolCallSignature(call.toolName, call.input);
        const seen = (repeatedToolCalls.get(signature) ?? 0) + 1;
        repeatedToolCalls.set(signature, seen);

        this.logger.debug("[TOOL-CALLS] Validating call", {
          callId,
          toolName: call.toolName,
          inputSize: JSON.stringify(call.input).length,
          repeatCount: seen,
        });

        if (seen > controls.maxRepeatedToolCall) {
          this.logger.warn("[TOOL-CALLS] Repeated tool call blocked", {
            callId,
            signature,
            repeatCount: seen,
            maxAllowed: controls.maxRepeatedToolCall,
          });
          resultMap.set(callId, { success: false, data: null, error: "Repeated tool call blocked" });
          continue;
        }

        // Phase 1: Check if this tool call has already failed and should not be retried
        if (!this.toolErrorTracker.shouldRetry(call.toolName, call.input as Record<string, unknown>)) {
          const failureInfo = this.toolErrorTracker.getToolFailureInfo(call.toolName);
          const skipReason = failureInfo
            ? `Previously failed: ${failureInfo.error} (error type: ${failureInfo.errorType}, ${failureInfo.retryCount} attempts)`
            : "Previously failed and max retries exceeded";

          this.logger.warn("[TOOL-CALLS] Skipping tool call due to previous failures", {
            callId,
            toolName: call.toolName,
            skipReason,
          });
          resultMap.set(callId, { success: false, data: null, error: skipReason });
          continue;
        }

        // Phase 2: Check circuit breaker status. Read-only calls are exempt: every recovery
        // instruction our tools give ("read the file first", "use action:'list'", "grep for it")
        // asks the model to OBSERVE something, so blocking observation is exactly what turns a
        // recoverable mistake into an unrecoverable run. Nothing is mutated by letting them
        // through, and they cannot be what broke the tool in the first place.
        if (!isReadOnlyToolCall(call.toolName, call.input) && !this.circuitBreaker.canExecute(call.toolName)) {
          const circuitStatus = this.circuitBreaker.getStatus(call.toolName);
          const skipReason = `Tool circuit breaker is ${circuitStatus.status} after ${circuitStatus.failureCount} failures`;

          this.logger.warn("[TOOL-CALLS] Skipping tool call due to circuit breaker", {
            callId,
            toolName: call.toolName,
            status: circuitStatus.status,
            failureCount: circuitStatus.failureCount,
          });
          resultMap.set(callId, { success: false, data: null, error: skipReason });
          continue;
        }

        // A write extracted from a CUT-OFF response carries a cut-off file.
        //
        // When the model exhausts its output budget mid-content, the JSON repair pass closes the
        // dangling string and hands over whatever had arrived. Measured on a 30 KB document:
        // a response cut at 90% yielded 27 075 of 30 064 characters - a file that looks finished,
        // is not, and was written with success:true. The model has no way to notice, because from
        // its side the call succeeded.
        //
        // `finish_reason: "length"` is the provider telling us exactly this happened, so a
        // content-bearing call from such a response is refused rather than half-applied. Reads,
        // greps and every other action still run: only the ones that would persist a truncated
        // payload are held back.
        if (responseWasTruncated && callWouldPersistContent(call.toolName, call.input)) {
          const truncationError =
            "Refusing to write from a truncated response. The model hit its output limit partway " +
            "through this call, so the content is incomplete - writing it would leave a file that " +
            "looks finished but is cut off. Write the file in parts instead: one write with the " +
            "first section, then append calls for the rest, each small enough to finish inside one " +
            "response.";
          this.logger.warn("[TOOL-CALLS] Blocked a content write from a truncated response", {
            callId,
            toolName: call.toolName,
          });
          emit("guardrail", "Abgeschnittene Antwort: Schreibvorgang verhindert", {
            toolName: call.toolName,
            path: call.input["path"],
          });
          resultMap.set(callId, { success: false, data: null, error: truncationError });
          continue;
        }

        let preflight = await this.preflightToolInput(call.toolName, call.input, controls);
        if (!preflight.ok) {
          // Self-repair applies HERE too, not only to calls that made it to execution.
          //
          // A malformed call is the single most repairable kind of failure - a wrong field
          // name, a missing argument - and it is exactly the kind preflight catches. But
          // preflight rejections used to skip straight to "record a failure and move on",
          // so the repair machinery below never saw the errors best suited to it: the model
          // just got the same complaint back and repeated the same call until the run died.
          // The ORIGINAL call is the yardstick for every repair round, never the previously
          // repaired one. Comparing each round against its predecessor lets an empty body creep
          // in one harmless-looking step at a time: round 1 fixes the shape, round 2 adds
          // `content: ""`, round 3 adds `allowEmpty` - and each step looks fine next to the one
          // before it. Against the original, a body that was never there stays never there.
          const originalCallInput = call.input as Record<string, unknown>;
          let repairedPreflightInput = originalCallInput;
          let repairAttempt = 0;

          // Re-evaluated EVERY pass, not once up front. A repair can turn some other complaint
          // INTO the empty-content one, and a guard computed from the first error would let the
          // loop sail straight past it - which is exactly what happened: the first error was
          // "'action' parameter required", so the guard was false, and three rounds later a
          // 0-byte write sailed through.
          const mustNotRepair = (): boolean =>
            !preflight.ok && preflight.error.startsWith("Refusing to write an empty file");

          while (
            !preflight.ok &&
            !mustNotRepair() &&
            controls.selfRepairEnabled &&
            repairAttempt < controls.selfRepairMaxAttempts
          ) {
            const repair = await this.attemptSelfRepair(
              call.toolName,
              repairedPreflightInput,
              preflight.error ?? "Invalid tool input",
              this.deriveToolRecoveryHint(call.toolName, repairedPreflightInput, preflight.error ?? "")
            );
            repairAttempt++;
            if (!repair) break;

            // Self-repair fixes a call's shape, never its payload - see sanitizeRepairedInput.
            const safeInput = this.sanitizeRepairedInput(call.toolName, originalCallInput, repair.input);
            if (!safeInput) break;

            repairedPreflightInput = safeInput;
            preflight = await this.preflightToolInput(repair.toolName, safeInput, controls);
          }

          if (!preflight.ok) {
            this.logger.warn("[TOOL-CALLS] Preflight validation failed", {
              callId,
              toolName: call.toolName,
              error: preflight.error,
              repairAttempts: repairAttempt,
            });
            resultMap.set(callId, { success: false, data: null, error: preflight.error });
            continue;
          }

          emit("guardrail", `Tool-Aufruf automatisch korrigiert: ${call.toolName}`, {
            toolName: call.toolName,
            attempts: repairAttempt,
          });
        }

        // Phase 2 (was previously registered but never invoked - see HookRegistry): give
        // beforeTool hooks (e.g. CodingAgent's read-before-edit discipline and shell command
        // approval policy) a chance to block this specific call before it executes.
        const hookResult = await this.executeHookSafely(AGENT_HOOK_NAMES.BEFORE_TOOL, {
          toolName: call.toolName,
          input: preflight.input,
          preflight: { validated: true },
        });
        if (!hookResult.proceed) {
          this.logger.warn("[TOOL-CALLS] Blocked by beforeTool hook", {
            callId,
            toolName: call.toolName,
            reason: hookResult.reason,
          });
          resultMap.set(callId, { success: false, data: null, error: hookResult.reason ?? "Blocked by beforeTool hook" });
          continue;
        }

        validCalls.push({ id: callId, toolName: call.toolName, input: preflight.input });
      }

      const validationTime = Date.now() - batchValidationStart;
      this.logger.info("[TOOL-CALLS] Validation complete", {
        validCalls: validCalls.length,
        rejectedCalls: batch.length - validCalls.length,
        validationTimeMs: validationTime,
      });

      if (validCalls.length === 0) {
        this.logger.info("[TOOL-CALLS] No valid calls in batch after validation, skipping execution");
        continue;
      }

      // Execute batch (Browser calls are sequential thanks to executeBatch override)
      const batchExecutionStart = Date.now();
      this.logger.info("[TOOL-CALLS] Starting batch execution", {
        callCount: validCalls.length,
        isParallel: validCalls.length > 1 && !validCalls.some((c) => c.toolName === "browser"),
      });

      const executedResults = await this.executor.executeBatch(validCalls);
      const batchExecutionTime = Date.now() - batchExecutionStart;

      this.logger.info("[TOOL-CALLS] Batch execution complete", {
        executionTimeMs: batchExecutionTime,
        resultCount: executedResults.length,
        successCount: executedResults.filter((r) => r.result.success).length,
      });

      // Store results, add to conversation, and emit events
      let latestBrowserSessionId: string | undefined;

      // Exact id lookup. This used to be `toolCalls.find(c => executed.id.includes(c.toolName))`,
      // matching a call id like "batch_1_0" against tool names - which never matches, so every
      // result was reported with an unknown tool. validCalls already carries the id/tool pairing.
      const callsById = new Map(validCalls.map((call) => [call.id, call]));

      for (const executed of executedResults) {
        resultMap.set(executed.id, executed.result);

        const toolCall = callsById.get(executed.id);

        // The standalone "plan" tool returns the plan as JSON but — unlike plan
        // mode — never surfaced it to the UI's plan panel, so users couldn't find
        // or execute it. Re-emit the same source:"plan_mode" panel event plan mode
        // uses, so a plan created via the tool is displayed and runnable too.
        if (toolCall?.toolName === "plan" && executed.result.success) {
          const data = executed.result.data as { plan?: unknown; markdown?: string } | undefined;
          if (data?.plan && typeof data.plan === "object") {
            try {
              const markdown = typeof data.markdown === "string"
                ? data.markdown
                : formatPlanAsMarkdown(data.plan as Plan);
              emit("plan", "Plan erstellt", {
                ...toPlanEventPayload(data.plan as Plan, markdown),
                phase: "done",
              });
            } catch (error) {
              this.logger.warn("Failed to emit plan panel event for plan tool", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }

        this.logger.info("[TOOL-CALLS] Tool execution result", {
          callId: executed.id,
          toolName: toolCall?.toolName,
          success: executed.result.success,
          disposition: (executed.result as any).disposition ?? "unknown",
          error: executed.result.error,
          resultSize: JSON.stringify(executed.result.data).length,
        });

        // Phase 1.5: Self-repair - a failed call is corrected (mechanically, or via a
        // targeted LLM fix) and re-run immediately, bounded by selfRepairMaxAttempts,
        // before it's recorded as a permanent failure. This runs BEFORE error tracking/
        // circuit breaker below so those only ever see the final, post-repair outcome.
        if (!executed.result.success && toolCall && executed.result.error && controls.selfRepairEnabled) {
          let repairAttempts = 0;
          let repairedInput = toolCall.input as Record<string, unknown>;
          let repairedResult = executed.result;
          while (!repairedResult.success && repairAttempts < controls.selfRepairMaxAttempts) {
            const repair = await this.attemptSelfRepair(
              toolCall.toolName,
              repairedInput,
              repairedResult.error ?? "Unknown error",
              // The same actionable hint the model would get - the repair model can use it
              // just as well, and it was previously thrown away here.
              this.deriveToolRecoveryHint(toolCall.toolName, repairedInput, repairedResult.error ?? "")
            );
            if (!repair) break;
            // Same protection as the preflight loop: a repair may fix the call's shape, never
            // its payload. See sanitizeRepairedInput.
            const safeRepairInput = this.sanitizeRepairedInput(toolCall.toolName, repairedInput, repair.input);
            if (!safeRepairInput) break;
            repair.input = safeRepairInput;
            repairAttempts++;
            this.logger.info("[SELF-REPAIR] Retrying tool call with corrected input", {
              toolName: toolCall.toolName,
              attempt: repairAttempts,
              maxAttempts: controls.selfRepairMaxAttempts,
            });
            emit("guardrail", `Selbstkorrektur: ${toolCall.toolName} wird mit korrigierter Eingabe erneut versucht`, {
              toolName: toolCall.toolName,
              attempt: repairAttempts,
            });
            repairedInput = repair.input;
            repairedResult = await this.executor.execute(repair.toolName, repair.input);
          }
          if (repairAttempts > 0) {
            executed.result = repairedResult;
            resultMap.set(executed.id, repairedResult);
            emit(
              repairedResult.success ? "guardrail" : "guardrail",
              repairedResult.success
                ? `Selbstkorrektur erfolgreich: ${toolCall.toolName}`
                : `Selbstkorrektur ohne Erfolg nach ${repairAttempts} Versuch(en): ${toolCall.toolName}`,
              { toolName: toolCall.toolName, attempts: repairAttempts, success: repairedResult.success }
            );
          }
        }

        // Phase 1: Track tool failures for error deduplication
        if (!executed.result.success && toolCall && executed.result.error) {
          const error = new Error(executed.result.error);
          this.toolErrorTracker.track(
            toolCall.toolName,
            toolCall.input as Record<string, unknown>,
            error
          );
        }

        // Phase 2: Record result in circuit breaker. The error text travels with it - without
        // it the breaker cannot tell an outage from a mistyped argument and trips on both.
        if (toolCall) {
          this.circuitBreaker.recordResult(
            toolCall.toolName,
            executed.result.success,
            executed.result.error
          );
        }

        // A successful browser screenshot carries the actual image as base64 in
        // data.screenshot. Remove it from the tool result to save tokens (the actual
        // screenshot is added to the conversation as a separate vision message by
        // handleScreenshotCapture, so the model can analyze it). A multi-KB/MB base64
        // blob in the tool result would waste tokens and add nothing since the model
        // will see the same image in the vision message with better context.
        const rawResultData = executed.result.data as Record<string, unknown> | undefined;
        const screenshotBase64 = this.isBrowserTool(toolCall?.toolName) && executed.result.success
          ? (rawResultData?.["screenshot"] as string | undefined)
          : undefined;

        if (screenshotBase64) {
          const screenshotFormat = (rawResultData?.["metadata"] as { format?: string } | undefined)?.format ?? "jpeg";
          emit("browser_preview", `Screenshot: ${(rawResultData?.["url"] as string | undefined) ?? "preview"}`, {
            toolBatchId,
            tabId: rawResultData?.["sessionId"],
            url: rawResultData?.["url"],
            screenshot: screenshotBase64,
            format: screenshotFormat,
            isStreaming: false,
          });
        }

        const resultForLlm = screenshotBase64
          ? {
              ...executed.result,
              data: {
                ...rawResultData,
                screenshot: `[screenshot image, ${screenshotBase64.length} base64 chars - shown to the user directly, not included here]`,
              },
            }
          : executed.result;

        // Add tool result to conversation so LLM sees it in next iteration
        // Truncate very large results to avoid API token limits
        const maxResultSize = 8000; // 8KB limit per tool result
        const { json: truncatedJson, truncated, originalSize } = this.boundToolResultJson(
          resultForLlm,
          maxResultSize
        );

        // Format tool result: extract actual output for readability, keep full JSON as fallback
        let resultContent = truncatedJson;
        try {
          const parsed = JSON.parse(truncatedJson);
          if (parsed.data) {
            // If there's an output field, present it clearly
            if (typeof parsed.data === "object" && "output" in parsed.data) {
              resultContent = `Tool Result: ${parsed.data.output}\n\n[Full result: ${truncatedJson}]`;
            } else if (typeof parsed.data === "string") {
              resultContent = `Tool Result: ${parsed.data}`;
            }
          }
        } catch {
          // If parsing fails, use the raw JSON
        }

        // On failure, append an actionable recovery hint so the model self-corrects on the
        // next iteration instead of blindly repeating the same failing call (or giving up).
        // Previously deriveToolRecoveryHint existed but was never wired into this path, so its
        // guidance never reached the model — the gateway/Discord config failures in particular
        // left the agent stuck with only a raw error string.
        if (!executed.result.success && executed.result.error && toolCall) {
          const hint = this.deriveToolRecoveryHint(toolCall.toolName, toolCall.input, executed.result.error);
          if (hint) {
            resultContent = `${resultContent}\n\n[Recovery hint] ${hint}`;
          }
        }

        const toolResultMessage: LLMMessage = {
          role: "tool",
          content: resultContent,
          toolCallId: executed.id,
        };
        // Stamp read-only results with an identity so the context builder can drop superseded
        // copies of the same read instead of paying for the file twice (see buildToolResultDedupeKey).
        const dedupeKey = toolCall ? buildToolResultDedupeKey(toolCall.toolName, toolCall.input) : undefined;
        if (dedupeKey) {
          toolResultMessage.metadata = { toolName: toolCall!.toolName, dedupeKey };
        }
        await this.conversation.addMessage(toolResultMessage);
        this.history.add(toolResultMessage, toolCall?.toolName ?? "unknown");

        this.logger.info("[TOOL-CALLS] Added tool result to conversation", {
          callId: executed.id,
          toolName: toolCall?.toolName,
          resultSize: originalSize,
          truncated,
        });

        // Handle screenshot capture: extract image data and add as visual message to conversation
        await this.handleScreenshotCapture(
          toolCall?.toolName ?? "unknown",
          toolCall?.input ?? {},
          executed.result
        );

        // Extract and track the latest browser sessionId from results
        if (toolCall?.toolName === "browser" && executed.result.success) {
          const data = executed.result.data as Record<string, unknown> | undefined;
          const sessionId = data?.sessionId as string | undefined;
          if (sessionId) {
            latestBrowserSessionId = sessionId;
            this.logger.info("[TOOL-CALLS] Tracked browser sessionId from tool result", {
              sessionId,
              callId: executed.id,
            });
          }
        }

        // Lead with what ran, not with the internal call id: "call_1a2b3c: Success" told
        // the reader nothing about which tool produced it.
        const resultSummary = toolCall ? summarizeToolCall(toolCall.toolName, toolCall.input) : "tool";
        journalEntries.push({
          iteration: iterations,
          toolName: toolCall?.toolName ?? "unknown",
          summary: resultSummary,
          success: executed.result.success,
        });
        const resultOutcome = executed.result.success
          ? "OK"
          : `Fehler: ${executed.result.error ?? "unbekannt"}`;
        emit("tool_result", `${resultSummary} — ${resultOutcome}`, {
          toolBatchId,
          toolName: toolCall?.toolName,
          summary: resultSummary,
          callId: executed.id,
          success: executed.result.success,
          error: executed.result.error,
          dataKeys: executed.result.success && typeof executed.result.data === "object"
            ? Object.keys(executed.result.data as Record<string, unknown>)
            : undefined,
        });
      }

      // Browser session ID is tracked internally - no need to add to conversation
      // This keeps the conversation clean without system context noise
      if (latestBrowserSessionId) {
        this.logger.info("[TOOL-CALLS] Tracked browser sessionId internally", {
          sessionId: latestBrowserSessionId,
        });
      }
    }

    // Clean response by removing all tool markers and channel metadata
    this.logger.info("[TOOL-CALLS] Cleaning response text", {
      originalLength: response.length,
      toolMarkerCount: (response.match(/\[TOOL:/g) || []).length,
      channelMarkerCount: (response.match(/<\|channel>|<channel\|>/g) || []).length,
      toolCallMarkerCount: (response.match(/<\|tool_call>|<tool_call\|>/g) || []).length,
    });

    const cleanedResponse = response
      .replace(/\[TOOL:[A-Za-z_][A-Za-z0-9_\-]*[^\]\n(){}]*\]\r?\n[\s\S]*?\r?\n?\[\/TOOL\]/g, "") // Remove heredoc write blocks
      .replace(/\[\/TOOL\]/g, "")                           // Remove any stray heredoc terminators
      .replace(/\[TOOL:[^\]]*\]/g, "")                     // Remove [TOOL:...] markers
      .replace(/<\|channel>.*?<channel\|>/gs, "")          // Remove <|channel>...<channel|> blocks (multiline)
      .replace(/<\|channel>thought[^\n]*\n?/g, "")         // Remove <|channel>thought line markers
      .replace(/<channel\|>/g, "")                          // Remove <channel|> end markers
      .replace(/<\|tool_call>.*?<tool_call\|>/gs, "")      // Remove <|tool_call>...<tool_call|> blocks
      .replace(/<\|[a-zA-Z_]+>/g, "")                       // Remove remaining <|...> markers
      .trim();

    this.logger.info("[TOOL-CALLS] Response cleanup complete", {
      cleanedLength: cleanedResponse.length,
      removed: response.length - cleanedResponse.length,
    });

    // Count browser tools for iteration control
    const browserToolsCount = toolCalls.filter(c => this.isBrowserTool(c.toolName)).length;

    return { resultMap, cleanedResponse, browserToolsCount, journalEntries };
  }

  /**
   * Execute hooks safely with error handling and logging.
   * Returns {proceed: false} if any hook aborted; true otherwise.
   */
  private async executeHookSafely<TContext = unknown>(
    hookName: string,
    context: TContext
  ): Promise<{ proceed: boolean; reason?: string; output?: Record<string, unknown> }> {
    try {
      return await this.hookRegistry.executeHooks(hookName, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("Hook execution error", { hookName, error: message });
      return { proceed: false, reason: `Hook error: ${message}` };
    }
  }

  /** True when `complexity` is at least `min` on the low<medium<high scale. */
  private meetsMinComplexity(complexity: "low" | "medium" | "high", min: "low" | "medium" | "high"): boolean {
    const rank = { low: 1, medium: 2, high: 3 };
    return rank[complexity] >= rank[min];
  }

  /** Compile evidence (assistant text + tool results) for verifying one checklist step.
   *  A mid-task step's proof lives in the tool results, not only the final prose — and it
   *  must include evidence from EARLIER iterations, whose tool results have already scrolled
   *  out of the live message window. The run-loop accumulates that per-iteration into
   *  `evidenceLog`; we prefer it and fall back to the recent message tail when it is empty. */
  private compileChecklistEvidence(finalResponse: string, evidenceLog: string[] = []): string {
    if (evidenceLog.length > 0) {
      // Keep the most recent evidence (which is the most likely to contain the proof for the
      // steps still open) within the token budget by trimming from the front.
      return `${evidenceLog.join("\n")}\n\n[latest] ${finalResponse}`.slice(-12000);
    }
    const tail = this.conversation
      .getMessages()
      .filter((m) => m.role === "assistant" || m.role === "tool")
      .slice(-6)
      .map((m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${m.role}] ${content}`;
      })
      .join("\n");
    return `${tail}\n\n[latest] ${finalResponse}`.slice(-6000);
  }

  /**
   * Render the per-iteration checklist focus hint: the FULL numbered list with status glyphs,
   * the current step highlighted, its acceptance criterion, any prior failure, and a short
   * imperative. Deliberately English + terse so small/local models follow it reliably and stay
   * oriented (seeing the whole list stops them jumping ahead or redoing finished steps). Pure
   * over its inputs so it is unit-testable without running the loop.
   */
  private renderChecklistFocusHint(
    open: ChecklistItem,
    all: ChecklistItem[],
    priorFailure: string | undefined
  ): string {
    const doneCount = all.filter((i) => i.status === "done" || i.status === "unverified").length;
    const glyph = (s: string): string =>
      s === "done" || s === "unverified" ? "[x]"
        : s === "skipped" ? "[-]"
        : s === "failed" ? "[!]"
        : "[ ]";
    const list = [...all]
      .sort((a, b) => a.stepIndex - b.stepIndex)
      .map((i) => {
        const marker = i.id === open.id ? "  <-- DO THIS NOW" : "";
        return `${glyph(i.status)} ${i.stepIndex + 1}. ${i.title}${marker}`;
      })
      .join("\n");
    return (
      `\n\n## Task checklist (${doneCount}/${all.length} done)\n` +
      `${list}\n\n` +
      `CURRENT STEP: ${open.stepIndex + 1}. ${open.title}\n` +
      `Done when: ${open.acceptanceCriteria ?? open.title}\n` +
      (priorFailure ? `Your previous attempt failed: ${priorFailure} — fix exactly this.\n` : "") +
      `Instructions: Actually perform this step now with the right tool (write the file, ` +
      `send the message, fetch the data — do not just describe it). Do ONLY this one step, ` +
      `then continue. Never skip ahead or redo a step already marked [x].`
    );
  }

  /**
   * Renders the last few Run Journal entries as a compact system-prompt block so the
   * model can see what it already did this run and avoid repeating it. Only the most
   * recent entries are shown (independent of how many are retained in memory) to keep
   * the per-iteration token cost bounded.
   */
  private renderRunJournalHint(journal: RunJournalEntry[]): string {
    if (journal.length === 0) return "";
    const recent = journal.slice(-15);
    const list = recent
      .map((e, idx) => `${idx + 1}. [${e.success ? "ok" : "fail"}] ${e.summary}`)
      .join("\n");
    return `\n\n## Actions taken so far this run\n${list}\nDo not repeat an action already listed above unless it failed or the task requires it again.`;
  }

  /** First failure string from an item's stored verifyState JSON, if any. */
  private extractChecklistFailure(item: ChecklistItem): string | undefined {
    if (!item.verifyState) return undefined;
    try {
      const parsed = JSON.parse(item.verifyState) as { failures?: unknown };
      const failures = Array.isArray(parsed.failures) ? parsed.failures : [];
      const first = failures[0];
      return typeof first === "string" ? first : undefined;
    } catch {
      return undefined;
    }
  }

  private async runLoop(
    userInput: string,
    toolsUsed: string[],
    iterations: number,
    controls: AgentRuntimeControls,
    options: AgentRunOptions
  ): Promise<AgentRunResult> {
    const runStartTime = Date.now();
    const toolsUsedThisRun = new Set<string>(toolsUsed);

    // Reflection only ever sees the response TEXT, never the actual screenshot image - so for
    // a turn that captured one, it reliably (and wrongly) judges "no screenshot provided" and
    // has been observed fabricating a fake "[Image: ...]" description of content it never saw.
    // Tracked across iterations (browserToolsCount is loop-scoped) to gate every reflection
    // pass below - see the "Reflection & Self-Improvement Loop" section further down.
    let screenshotCapturedThisRun = false;

    // Initialize adjustedControls early so emit() can reference it
    let adjustedControls: AgentRuntimeControls | undefined;

    // Id and text of the most recent display row, returned with the result so the client can
    // tell that the final response is a repeat of a row it already has.
    let lastDisplayMessageId: string | undefined;
    let lastDisplayText: string | undefined;

    const emit = (
      type: AgentRunEventType | string,
      message: string,
      data?: Record<string, unknown>
    ) => {
      const timestamp = new Date().toISOString();
      const elapsed = Date.now() - runStartTime;

      // Build snapshot for granular event system (Phase 1)
      const snapshot = {
        conversationLength: (this.conversation as any).messages?.length ?? 0,
        currentIteration: iterations,
        maxIterations: (adjustedControls ?? controls).maxIterations,
        toolsUsedThisIteration: Array.from(toolsUsedThisRun),
        toolsUsedInRun: Array.from(toolsUsedThisRun),
        elapsed,
        timestamp,
      };

      // The live socket payload only carries `data` (snapshot is DB-only, see below), so
      // the UI has no way to know which iteration/tool-batch an event belongs to unless we
      // stamp it here. Every event gets `iteration`; tool events additionally carry
      // whatever `toolBatchId` the caller passed in `data` (used to fold a batch of tool
      // calls from one LLM turn into a single collapsible group in the chat UI).
      const dataWithIteration = { iteration: iterations, ...data };

      // Emit via V2 event emitter (batched, with snapshot)
      this.eventEmitterV2.emitEvent({
        type: type as AgentRunEventType,
        message,
        data: dataWithIteration,
        snapshot,
        timestamp,
      });

      // Also emit via onEvent callback (WebSocket handler)
      // For browser_preview, wait for storage operations; others fire-and-forget
      const eventPayload = {
        type: type as AgentRunEventType,
        message,
        data: dataWithIteration,
        timestamp,
      };

      if (type === "browser_preview") {
        // Wait for browser preview to complete (for screenshot storage)
        void (async () => {
          try {
            await options.onEvent?.(eventPayload);
          } catch (error) {
            this.logger.error("Error emitting browser_preview event", { error });
          }
        })();
      } else {
        // Fire and forget for other events
        void options.onEvent?.(eventPayload);
      }

      // Persist event timeline so reloaded chats can render tool/reasoning history.
      if (this.conversation.id !== undefined) {
        const eventMetadata: Record<string, unknown> = {
          eventType: type,
          data: dataWithIteration,
          timestamp,
          snapshot,
        };
        if (options.localMessageId) {
          eventMetadata.localMessageId = options.localMessageId;
        }
        const conversationId = this.conversation.id;
        // Queued rather than fired in parallel so the row ids stay in emit order, and stamped
        // with the event's own timestamp so the persisted copy is recognisably the same event
        // as the one already streamed to the client.
        this.eventPersistQueue = this.eventPersistQueue.then(() =>
          this.db
            .addMessage({
              conversationId,
              role: "event",
              content: message,
              toolResult: JSON.stringify(eventMetadata),
              metadata: options.localMessageId ? JSON.stringify({ localMessageId: options.localMessageId }) : undefined,
              createdAt: timestamp,
            })
            .catch(() => {
              // Ignore event persistence errors to avoid interrupting the run loop.
            })
        );
      }
    };

    /**
     * Publishes a block of user-facing agent text as its own timeline row.
     *
     * The run's raw model output is stored for the LLM's benefit and still carries tool
     * markers; the text the user should read was previously only streamed, never stored. That
     * left the client reconciling a live-only answer against rows never meant for display, and
     * every heuristic it used for that (turn ids, content+time windows) was a source of the
     * answer being duplicated or dropped. Writing the cleaned text as a real row - at the point
     * in the run where it was produced - gives it a position in the transcript and a stable id.
     *
     * Stored with role "event" deliberately: ConversationManager.load() only feeds
     * user/assistant/system/tool rows back into the LLM context, so a display row can never
     * duplicate the assistant turn it mirrors. It is mapped back to an assistant bubble by the
     * UI. `emit()` is bypassed on purpose - that would persist a second, competing row.
     */
    const emitDisplayText = (text: string): string | undefined => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return undefined;

      const displayMessageId = randomUUID();
      const timestamp = new Date().toISOString();

      void options.onEvent?.({
        type: "assistant_text" as AgentRunEventType,
        message: text,
        data: { displayMessageId, iteration: iterations },
        timestamp,
      });

      const conversationId = this.conversation.id;
      if (conversationId !== undefined) {
        const metadata: Record<string, unknown> = { displayMessageId };
        if (options.localMessageId) metadata.localMessageId = options.localMessageId;

        // Same queue as the event rows, so the row id (which is the transcript's running
        // order) matches the order things actually happened in.
        this.eventPersistQueue = this.eventPersistQueue.then(() =>
          this.db
            .addMessage({
              conversationId,
              role: "event",
              content: text,
              toolResult: JSON.stringify({
                eventType: "assistant_text",
                data: { displayMessageId, iteration: iterations },
                timestamp,
              }),
              metadata: JSON.stringify(metadata),
              createdAt: timestamp,
            })
            .catch(() => {
              // Never let a persistence failure interrupt the run.
            })
        );
      }

      return displayMessageId;
    };

    const rememberSuccessfulTool = async (
      toolName: string,
      toolInput: Record<string, unknown>,
      toolResult: ToolResult
    ): Promise<void> => {
      if (!adjustedControls!.enableAutoMemory) return;
      if (!toolResult.success) return;

      try {
        const decision = await this.memory.rememberFromSuccessfulTool(
          toolName,
          toolInput,
          toolResult.data,
          this.conversation.id
        );

        if (decision.stored) {
          emit("reasoning", "Memory aktualisiert aus erfolgreichem Tool-Erfolg.", {
            source: "tool_success",
            toolName,
            reason: decision.reason,
            importance: decision.importance,
            contentPreview: decision.content?.slice(0, 200),
          });
          return;
        }

        if (decision.shouldRemember) {
          emit("reasoning", "Memory-Eintrag verworfen (bereits bekannt).", {
            source: "tool_success",
            toolName,
            reason: decision.reason,
            contentPreview: decision.content?.slice(0, 200),
          });
        }
      } catch (error) {
        this.logger.warn("Automatic tool memory update failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Plan mode short-circuits the whole run loop: produce a structured plan and return
    // immediately, without selecting skills, building tool context, or entering the
    // iteration loop below. Checked before any of that setup runs since none of it is
    // needed - and skipping it keeps plan mode fast and side-effect-free.
    if (options.agentMode === "plan") {
      return await this.runPlanMode(userInput, options, emit);
    }

    // Determine agent mode (full, lightweight, or chatbot) - P3.2
    const explicitMode = options.agentMode ?? "full";
    const recentHistory = this.history.getLast(3);
    const hasRecentSkillUsage = recentHistory.some((entry) => entry.role === "tool" || entry.toolName);

    let effectiveMode: "full" | "lightweight" | "chatbot" = explicitMode;
    let modeDetection: ReturnType<typeof modeDetector.detectMode> | undefined;
    if (explicitMode === "full" && !hasRecentSkillUsage) {
      modeDetection = modeDetector.detectMode(userInput);
      if (modeDetection.preferredMode !== "full" && modeDetection.confidence >= 0.7) {
        effectiveMode = modeDetection.preferredMode;
      }
    }
    // Fallback heuristic kept as a secondary signal in case the classifier misses obvious
    // short/simple inputs (e.g. confidence just under threshold).
    const detectedLightweightMode = effectiveMode === "full"
      && this.shouldUseLightweightMode(userInput, hasRecentSkillUsage);
    if (detectedLightweightMode) {
      effectiveMode = "lightweight";
    }

    // If user has explicitly set a high maxIterations value (e.g. via settings),
    // don't auto-downgrade to chatbot mode (which caps at 5), but allow lightweight for simple queries
    const userSetHighIterations = this.maxIterations > 50; // 50 is the default
    if (userSetHighIterations && effectiveMode === "chatbot") {
      // Only keep full mode if we were downgraded all the way to chatbot
      // Allow lightweight for simple queries even with high iterations
      effectiveMode = "lightweight";
    }

    if (effectiveMode !== "full") {
      emit("mode_selected", `Agent operating in ${effectiveMode} mode`, {
        mode: effectiveMode,
        autoDetected: Boolean(modeDetection) || detectedLightweightMode,
        complexity: modeDetection?.estimatedComplexity,
        confidence: modeDetection?.confidence,
        inputLength: userInput.length,
        hasSkillPrefix: userInput.trim().startsWith("/"),
      });
    }

    // Date/time questions are almost always short enough for shouldUseLightweightMode to
    // route them into lightweight/chatbot mode below, which otherwise skips loading skill
    // manifests entirely - that left the dedicated datum-uhrzeit-tag skill permanently
    // unreachable for exactly the queries it exists to handle, so the LLM fell back to
    // shelling out to a Unix `date` command that doesn't exist on Windows.
    const isDateTimeQuery = this.isDateTimeIntent(userInput);

    // Detect what tools/queries are involved - this affects iteration limits for ALL modes
    const hasBrowserTool = userInput.toLowerCase().includes("browser") ||
                           userInput.toLowerCase().includes("screenshot") ||
                           userInput.toLowerCase().includes("navigate") ||
                           userInput.toLowerCase().includes("goto");
    const hasTaskTool = userInput.toLowerCase().includes("task") ||
                        userInput.toLowerCase().includes("project") ||
                        userInput.toLowerCase().includes("tracked");

    // In lightweight/chatbot modes, limit iterations and disable planning/reflection
    adjustedControls = { ...controls };

    // Adjust iteration limits based on detected tools/queries (applies to all modes)
    if (hasTaskTool) {
      // Task execution needs 5+ iterations: execute tools, read results, generate response
      adjustedControls.maxIterations = Math.min(Math.max(5, controls.maxIterations), 10);
    } else if (isDateTimeQuery || hasBrowserTool) {
      // Browser/Date-time queries need 4+ iterations
      adjustedControls.maxIterations = Math.min(Math.max(4, controls.maxIterations), 10);
    }

    this.logger.debug("[RUNLOOP] Mode and iteration adjustment", {
      effectiveMode,
      currentMaxIterations: controls.maxIterations,
      adjustedMaxIterations: adjustedControls.maxIterations,
      hasTaskTool,
      hasBrowserTool,
      isDateTimeQuery,
      userInputPreview: userInput.substring(0, 100),
    });

    if (effectiveMode === "lightweight") {
      // Lightweight mode: cap at the configurable lightweight ceiling
      // (AGENT_LIGHTWEIGHT_MAX_ITERATIONS, default 10) while never exceeding the
      // user's global maxIterations. Previously this 10 was hard-coded.
      adjustedControls.maxIterations = Math.min(adjustedControls.lightweightMaxIterations, controls.maxIterations);
      // Reflection disabled in lightweight mode:
      // - Reflection adds 1+ LLM calls per retry, consuming significant iteration budget
      // - With only 5 iterations total, reflection could consume 20%+ of the budget
      // - Trade-off: Prioritize speed/responsiveness over self-correction on simple queries
      // - Note: This can be revisited if lightweight mode responses need quality improvement
      adjustedControls.enableReflection = false;
      adjustedControls.reflectionMaxRetries = 0;
      // Verify is disabled here for the same reason as reflection: it adds
      // several slow LLM round-trips (grade + fix-loop) after the visible answer,
      // which on local models can add minutes of apparent "hang" on exactly the
      // short/tool-heavy queries lightweight mode is meant to keep fast.
      adjustedControls.enableVerify = false;
    } else if (effectiveMode === "chatbot") {
      // chatbot mode's normal cap of 1 iteration means "make a tool call" and "read the
      // tool's result back to the user" can never both happen - the loop exits right after
      // the call, before a second pass could let the model see the result and answer in
      // words. A date/time question that lands in chatbot mode still needs exactly that one
      // tool round-trip, so it gets the same 2-iteration budget as lightweight mode instead
      // of silently ending in "no answer generated" despite the tool having succeeded.
      // Similarly, browser tools that capture screenshots need 2 iterations: first to take
      // the screenshot, second to analyze the vision message that was added.
      // Task execution needs 3 iterations: execute, read result, generate response
      const hasBrowserTool = userInput.toLowerCase().includes("browser") ||
                             userInput.toLowerCase().includes("screenshot") ||
                             userInput.toLowerCase().includes("navigate") ||
                             userInput.toLowerCase().includes("goto");
      const hasTaskTool = userInput.toLowerCase().includes("task") ||
                          userInput.toLowerCase().includes("project") ||
                          userInput.toLowerCase().includes("tracked");

      // Chatbot mode: the configurable chatbot ceiling
      // (AGENT_CHATBOT_MAX_ITERATIONS, default 5) is the base. Tool round-trips
      // raise the floor so a tool call and its answer both fit, but the result
      // never exceeds the user's global maxIterations.
      // Preserve the previous per-tool floors (task 10, browser/date-time 8) so a
      // tool call and its answer both fit; the configured ceiling only *raises*
      // them, never drops below the round-trip minimum.
      const chatbotCap = adjustedControls.chatbotMaxIterations;
      if (hasTaskTool) {
        adjustedControls.maxIterations = Math.min(Math.max(chatbotCap, 10), controls.maxIterations);
      } else if (isDateTimeQuery || hasBrowserTool) {
        adjustedControls.maxIterations = Math.min(Math.max(chatbotCap, 8), controls.maxIterations);
      } else {
        // Other simple queries: use the configured chatbot ceiling directly
        adjustedControls.maxIterations = Math.min(chatbotCap, controls.maxIterations);
      }
      // Reflection disabled in chatbot mode:
      // - Chatbot mode has only 1-5 iterations total (vs 50 in full mode)
      // - Reflection would consume all remaining iterations
      // - No room for tool calls + reflection + response generation
      adjustedControls.enableReflection = false;
      adjustedControls.reflectionMaxRetries = 0;
      // Verify disabled in chatbot mode for the same latency reason as lightweight.
      adjustedControls.enableVerify = false;
    }

    // Phase 2 cost governor: fresh per-run accumulator using the effective budget.
    this.costTracker = new CostTracker(adjustedControls.costBudgetUsd, this.logger);
    // Phase 4: refresh the vision gate from settings for this run.
    this.visionEnabled = adjustedControls.enableVision;

    // Disable the slow post-response quality passes for coding work: on long code
    // responses with a local model each pass repeatedly hits its timeout, wasting
    // minutes for little value. This covers two cases WITHOUT touching the normal
    // chat agent: the dedicated CodingAgent (disableQualityPasses), and interactive
    // coding-area runs, which route through the regular agent but carry the
    // [CODING_CONTEXT] marker the coding page prepends to every prompt.
    // Coding runs get their own configurable settings (Agent tab → Coding Agent),
    // applied ONLY here so the normal chat agent is untouched. Covers the coding-area
    // chat (regular agent + [CODING_CONTEXT] marker) and the dedicated CodingAgent.
    const isCodingContextRun = typeof userInput === "string" && userInput.includes("[CODING_CONTEXT]");
    const codingRun = this.disableQualityPasses || isCodingContextRun;
    if (codingRun) {
      // Quality passes: off by default for coding (they time out on slow local models),
      // but re-enableable via settings.
      if (!adjustedControls.codingEnableReflection) {
        adjustedControls.enableReflection = false;
        adjustedControls.reflectionMaxRetries = 0;
        adjustedControls.reflectionMetaReview = false;
        adjustedControls.reflectionPostIteration = false;
      }
      adjustedControls.enableVerify = adjustedControls.codingEnableVerify;
      // Coding is multi-step; use the configurable coding iteration budget instead
      // of the general mode caps (5-10) that cut large tasks short.
      adjustedControls.maxIterations = adjustedControls.codingMaxIterations;
    }

    const installedSkillManifests = (effectiveMode === "full" || isDateTimeQuery) ? this.loadSkillManifests() : [];
    const { slugs: requestedSkillSlugs, stripped: effectiveInput } = this.extractRequestedSkillSlugs(userInput);

    // Persist the user turn before any decision/reasoning events are emitted so
    // timeline ordering is stable in both live and persisted chat views.
    const userMetadata: Record<string, unknown> = {};
    if (options.attachments?.length) {
      userMetadata.attachments = options.attachments;
    }
    if (options.localMessageId) {
      userMetadata.localMessageId = options.localMessageId;
    }
    const userMessage: LLMMessage = {
      role: "user",
      content: effectiveInput,
      metadata: Object.keys(userMetadata).length > 0 ? userMetadata : undefined,
    };
    await this.conversation.addMessage(userMessage);
    this.history.add(userMessage);

    const enabledAllowlist = new Set(controls.enabledSkillAllowlist);
    const allowlistCandidates = installedSkillManifests.filter((skill) => enabledAllowlist.has(skill.slug));
    const dateSkillFallback = installedSkillManifests.find((skill) => skill.slug === "datum-uhrzeit-tag");
    if (dateSkillFallback && this.isDateTimeIntent(effectiveInput) && !allowlistCandidates.some((skill) => skill.slug === dateSkillFallback.slug)) {
      allowlistCandidates.push(dateSkillFallback);
      emit("decision", "Utility date/time skill injected for date intent", {
        skill: dateSkillFallback.slug,
        reason: "date_time_intent",
      });
    }
    const requestedSkills = requestedSkillSlugs
      .map((slug) => installedSkillManifests.find((skill) => skill.slug === slug))
      .filter((skill): skill is SkillManifest => Boolean(skill));

    const workflowOrchestratorRequested = requestedSkillSlugs.includes("workflow-orchestrator");
    const prioritizedRequestedSkillManifests = workflowOrchestratorRequested
      ? [
          ...requestedSkills.filter((skill) => skill.slug === "workflow-orchestrator"),
          ...requestedSkills.filter((skill) => skill.slug !== "workflow-orchestrator"),
        ]
      : requestedSkills;

    const selectedSlugs = new Set(prioritizedRequestedSkillManifests.map((skill) => skill.slug));
    const autoSkillSelection = this.selectAutoSkill(effectiveInput, allowlistCandidates, selectedSlugs, controls);
    const autoSkill = autoSkillSelection.selected;

    const alwaysLoadSkills = controls.alwaysLoadSkills
      ? installedSkillManifests.filter((skill) => controls.alwaysLoadSkills!.includes(skill.slug))
      : [];

    let activeSkillManifests: SkillManifest[] = [...alwaysLoadSkills, ...prioritizedRequestedSkillManifests];

    if (controls.skillBehavior === "active") {
      const additionalActive = allowlistCandidates.filter((skill) => !selectedSlugs.has(skill.slug));
      activeSkillManifests = [...activeSkillManifests, ...additionalActive];
    } else {
      this.autoSkillSelectionAttempts++;
      if (autoSkill) this.autoSkillSelections++;

      if (autoSkill) {
        activeSkillManifests = [...activeSkillManifests, autoSkill];
      } else if (!controls.autoSkillFallbackNone) {
        const fallbackSkills = allowlistCandidates.filter((skill) => !selectedSlugs.has(skill.slug));
        activeSkillManifests = [...activeSkillManifests, ...fallbackSkills];
      }
    }

    // The Jaccard/overlap scorer above routinely rejects this skill even when
    // isDateTimeIntent is certain: its manifest text is English ("Provides current date,
    // time...") while requests are often German ("wie spät ist es?"), so token overlap with
    // a German question is near-zero and never clears autoSkillMinOverlap. Unlike the fuzzy
    // auto-select, isDateTimeIntent is a deterministic, high-confidence signal, so force-
    // include the skill directly instead of leaving it to a scoring pipeline it structurally
    // can't pass - still gated on enableAutoSkillSelection so a user who disabled auto skill
    // selection entirely is respected.
    if (
      dateSkillFallback &&
      controls.enableAutoSkillSelection &&
      this.isDateTimeIntent(effectiveInput) &&
      !activeSkillManifests.some((skill) => skill.slug === dateSkillFallback.slug)
    ) {
      activeSkillManifests = [...activeSkillManifests, dateSkillFallback];
      emit("decision", "Utility date/time skill force-included", {
        skill: dateSkillFallback.slug,
        reason: "date_time_intent_deterministic",
      });
    }

    const relatedSkillManifests = this.expandRelatedSkills(
      activeSkillManifests,
      installedSkillManifests,
      enabledAllowlist
    ).filter((skill) => !activeSkillManifests.some((current) => current.slug === skill.slug));

    if (relatedSkillManifests.length > 0) {
      activeSkillManifests = [...activeSkillManifests, ...relatedSkillManifests];
    }

    const activeSkills = activeSkillManifests.map((skill) => this.loadSkillContent(skill));
    const activeSkillSlugs = activeSkills.map((skill) => skill.slug);
    this.activeSkillSlugsForRun = new Set(activeSkillSlugs);
    const workflowOrchestratorActive = activeSkillSlugs.includes("workflow-orchestrator");

    // Track ever-used skills (non-blocking)
    if (activeSkillSlugs.length > 0) {
      this.db.addEverUsedSkills(activeSkillSlugs).catch((error) => {
        this.logger.warn("Failed to track ever-used skills", {
          error: error instanceof Error ? error.message : String(error),
          skills: activeSkillSlugs,
        });
      });
    }

    // Register skill embeddings for semantic indexing (P3.3)
    for (const skill of activeSkills) {
      const skillContent = `${skill.name} ${skill.description || ""} ${skill.content?.slice(0, 500) || ""}`;
      skillSelector.registerSkillEmbedding(skill.slug, skillContent);
    }

    emit("decision", "Skill behavior controls applied", {
      behavior: controls.skillBehavior,
      fallbackNone: controls.autoSkillFallbackNone,
      allowlistSize: controls.enabledSkillAllowlist.length,
    });

    if (activeSkills.length > 0) {
      emit(
        "reasoning",
        `Skills geladen: ${activeSkills.map((s) => s.slug).join(", ")}`,
        { skills: activeSkills.map((s) => ({ slug: s.slug, name: s.name })) }
      );
    }

    if (relatedSkillManifests.length > 0) {
      emit("decision", "Related skills auto-loaded", {
        requestedOrSelected: activeSkillManifests
          .map((skill) => skill.slug)
          .filter((slug, index, all) => all.indexOf(slug) === index),
        autoRelated: relatedSkillManifests.map((skill) => skill.slug),
      });
    }

    if (controls.skillBehavior === "automatic") {
      if (autoSkill) {
        emit("decision", "Skill auto-selected after relevance check", {
          skill: autoSkill.slug,
          threshold: controls.autoSkillScoreThreshold,
          marginThreshold: controls.autoSkillMarginThreshold,
          minOverlap: controls.autoSkillMinOverlap,
        });
      } else if (autoSkillSelection.reason !== "disabled") {
        emit("decision", "No auto skill selected", {
          reason: autoSkillSelection.reason,
          threshold: controls.autoSkillScoreThreshold,
          marginThreshold: controls.autoSkillMarginThreshold,
          minOverlap: controls.autoSkillMinOverlap,
          fallbackNone: controls.autoSkillFallbackNone,
        });
      }
    } else {
      emit("decision", "Active skill mode loaded all enabled skills", {
        loaded: activeSkillSlugs,
      });
    }

    if (controls.skillBehavior === "automatic" && autoSkillSelection.scored.length > 0) {
      emit("decision", "Skill relevance ranking", {
        top: autoSkillSelection.scored.slice(0, 3).map((item) => ({
          slug: item.skill.slug,
          score: Number(item.score.toFixed(3)),
          overlap: item.overlap,
        })),
      });
      const hitRate = this.autoSkillSelectionAttempts > 0
        ? this.autoSkillSelections / this.autoSkillSelectionAttempts
        : 0;
      emit("decision", "Auto skill hit rate", {
        attempts: this.autoSkillSelectionAttempts,
        selected: this.autoSkillSelections,
        hitRate: Number(hitRate.toFixed(3)),
      });
    }

    if (workflowOrchestratorActive && activeSkills.length > 1) {
      emit("guardrail", "Skill priority applied", {
        prioritized: "workflow-orchestrator",
        alsoLoaded: activeSkills.filter((s) => s.slug !== "workflow-orchestrator").map((s) => s.slug),
      });
    }

    let memoryContext = "";
    try {
      memoryContext = await this.memory.buildSystemContext(this.conversation.id);
    } catch (memoryError) {
      this.logger.warn("Failed to build system memory context", {
        error: memoryError instanceof Error ? memoryError.message : String(memoryError),
      });
    }

    // Conversation compression (P3.1): summarize older history once per run so long
    // conversations don't keep growing the LLM context unbounded. Only kicks in past the
    // threshold and only in full mode; recent messages still flow through unmodified via
    // buildConversationWindow below - this just adds a synopsis of what got cut off.
    let conversationSummaryContext = "";
    if (effectiveMode === "full") {
      const allConversationMessages = this.conversation.getMessages();
      if (this.conversationCompressor.shouldCompress(allConversationMessages.length)) {
        try {
          const { summaries } = await this.conversationCompressor.buildCompressedContext(allConversationMessages, 20);
          if (summaries.length > 0) {
            conversationSummaryContext = `\n\n## Earlier Conversation Summary\n${summaries
              .map((s, i) => `[Part ${i + 1}] ${s.summary}${s.keyDecisions.length > 0 ? ` (Key points: ${s.keyDecisions.join("; ")})` : ""}`)
              .join("\n")}`;
            emit("decision", "Older conversation history compressed", {
              segments: summaries.length,
              totalMessages: allConversationMessages.length,
            });
          }
        } catch (error) {
          this.logger.warn("Conversation compression failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const toolManifests = this.getToolManifests();
    const enabledOptionalToolsSet = new Set(controls.enabledOptionalTools);
    const availableTools = this.executor
      .listTools()
      .filter((tool) => isToolActive(tool.name, toolManifests, enabledOptionalToolsSet));
    const toolContext = availableTools.length > 0
      ? `\n\n## Available Tools\n${availableTools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")}`
      : "";
    // A caller-supplied plan (e.g. the user-approved plan from the UI's Plan tab) is used
    // AS-IS instead of calling the Planner - without this, the agent always re-derived its
    // OWN plan from the flattened prompt text via a fresh LLM call, silently discarding the
    // structured steps the caller already had (and that the user already reviewed/approved).
    const usingExternalPlan = Boolean(options.existingPlan);
    const enablePlanningInMode = this.enablePlanning && effectiveMode === "full";
    let planContext = options.existingPlan
      ? options.existingPlan
      : enablePlanningInMode
        ? await this.planner.createPlan(effectiveInput, availableTools.map((tool) => tool.name), {
            currentModel: this.provider.model,
            budgetUsd: adjustedControls.costBudgetUsd,
          })
        : undefined;
    if (planContext) {
      // source:"auto" marks this as internal run-loop context, not a user-facing plan:
      // the UI only opens its plan panel for source:"plan_mode" events, so an auto-plan
      // in full mode stays a log entry instead of interrupting the run with a modal.
      emit("plan", `Plan erstellt mit ${planContext.steps.length} Schritt(en).`, {
        source: usingExternalPlan ? "external" : "auto",
        complexity: planContext.estimatedComplexity,
        overallRiskLevel: planContext.overallRiskLevel,
        totalEstimatedCostUsd: planContext.totalEstimatedCostUsd,
        totalEstimatedTokens: planContext.totalEstimatedTokens,
        steps: planContext.steps.map((step) => ({ id: step.id, title: step.title })),
      });
      // Surface the (non-binding) downgrade suggestion when the plan exceeds budget.
      // We never switch models autonomously (AGENT_AUTO_DOWNGRADE defaults off).
      if (planContext.downgradeSuggestion) {
        emit("guardrail", "Plan exceeds budget — downgrade suggested", {
          suggestion: planContext.downgradeSuggestion,
          autoDowngrade: adjustedControls.autoDowngrade,
        });
      }
    }

    // === SESSION CHECKLIST: derive from the plan (opt-in via AGENT_CHECKLIST_ENABLED, OR
    // always-on for a caller-supplied plan - a plan the user explicitly approved and asked
    // to execute should always get per-step tracking/verification, not just when the global
    // heuristic threshold happens to be met). See docs/session-checklist-plan.md. ===
    const checklistCfg = {
      enabled: controls.checklistEnabled,
      minComplexity: controls.checklistMinComplexity,
      // A caller-scoped override (EXECUTION_MODE_MAX_RETRIES for plan execution) takes
      // precedence over the agent-wide AGENT_CHECKLIST_MAX_ITEM_ATTEMPTS default.
      maxItemAttempts: options.checklistMaxItemAttemptsOverride ?? controls.checklistMaxItemAttempts,
      skippedPolicy: controls.checklistSkippedPolicy,
    };
    const checklistRunId = `run-${Date.now()}`;
    let checklistActive = false;
    // Rolling per-run evidence log for checklist verification. Tool results and assistant
    // text are captured HERE, while fresh, each iteration — otherwise an early step's proof
    // has already rolled out of the message window by the time it is verified at loop end,
    // which caused correctly-completed steps to be falsely reported as failed/skipped.
    const checklistEvidenceLog: string[] = [];
    // Always-on, checklist-independent record of tool actions taken this run (see
    // RunJournalEntry) — reminds the model what it already did so it doesn't repeat work.
    // Separate from checklistEvidenceLog: this holds short structured summaries for the
    // acting model, not raw evidence for the verifier.
    // Seeded from options.initialRunJournal when a caller (CodingAgent, across its own
    // plan->verify->iterate attempts) explicitly carries a prior run's journal forward;
    // regular one-shot callers never set this, so they still start empty as before.
    const runJournal: RunJournalEntry[] = options.initialRunJournal ? [...options.initialRunJournal] : [];
    const runJournalEnabled = controls.runJournalEnabled;
    // Monotonic counters (survive the log's 40-entry cap) gating the mid-run advance so the
    // Verifier is only invoked when NEW evidence has arrived since the last check — never
    // re-verifying identical evidence iteration after iteration.
    let checklistEvidencePushes = 0;
    let checklistLastAdvanceAt = -1;
    // Wall-clock throttle for the mid-run verify pass (EXECUTION_MODE_VALIDATION_INTERVAL
    // for plan execution). The evidence-count gate above already avoids re-verifying
    // unchanged evidence; this additionally caps how OFTEN the (LLM-backed) verifier runs
    // at all, for callers that want to bound its cost/frequency during a long plan run.
    let checklistLastVerifyAtMs = 0;
    if (
      (checklistCfg.enabled || usingExternalPlan) &&
      planContext &&
      this.conversation.id !== undefined &&
      (usingExternalPlan || this.meetsMinComplexity(planContext.estimatedComplexity, checklistCfg.minComplexity))
    ) {
      const items = await this.checklistManager.deriveFromPlan(planContext, this.conversation.id, checklistRunId);
      if (items.length > 0) {
        checklistActive = true;

        // Guarantee the iteration budget can actually reach every step. Task-type heuristics
        // above may have LOWERED maxIterations (e.g. a "lightweight"/chatbot cap), and each
        // checklist step realistically costs a few iterations (act with a tool → model
        // summarizes → verify/advance), sometimes plus an empty-response recovery. Without
        // this, multi-step runs died at maxIterations with later steps still "open" (the run
        // in the report stopped after step 2 with steps 3-5 never attempted). Bounded by the
        // user's global maxIterations so we never exceed their configured ceiling.
        const perStepBudget = 4;
        const neededForChecklist = items.length * perStepBudget + 4;
        const bumped = Math.min(controls.maxIterations, Math.max(adjustedControls.maxIterations, neededForChecklist));
        if (bumped > adjustedControls.maxIterations) {
          this.logger.info("[CHECKLIST] Raised iteration budget to cover all steps", {
            from: adjustedControls.maxIterations,
            to: bumped,
            steps: items.length,
          });
          adjustedControls.maxIterations = bumped;
        }

        emit("checklist", `Checkliste erstellt (${items.length} Schritte).`, {
          phase: "created",
          runId: checklistRunId,
          total: items.length,
          doneCount: 0,
          items: items.map((i) => ({ index: i.stepIndex, title: i.title, status: i.status })),
        });
      }
    }
    const installedSkillsContext = installedSkillManifests.length > 0
      ? `\n\n## Installed Skills\n${installedSkillManifests
          .map((skill) => `- ${skill.slug}: ${skill.description ?? "No description"}`)
          .join("\n")}`
      : "";

    const requestedSkillsContext = activeSkills.length > 0
      ? `\n\n## Loaded Skills\n${activeSkills
          .map((skill) => `### ${skill.slug}\n${skill.content}`)
          .join("\n\n")}`
      : "";

    const compactSkillManifests = workflowOrchestratorActive
      ? activeSkills.filter((skill) => skill.slug === "workflow-orchestrator")
      : [];
    const compactRequestedSkillsContext = compactSkillManifests.length > 0
      ? `\n\n## Loaded Skills\n${compactSkillManifests
          .map((skill) => `### ${skill.slug}\n${skill.content}`)
          .join("\n\n")}`
      : "";

    const taskRules = taskRulesGuidance();
    const platformHint = platformHintGuidance(options.channelHint as PlatformChannel | undefined);

    const baseSystemPrompt =
      this.systemPrompt +
      installedSkillsContext +
      requestedSkillsContext +
      toolContext +
      (planContext ? `\n\n## Working Plan\n${JSON.stringify(planContext, null, 2)}` : "") +
      memoryContext +
      conversationSummaryContext +
      platformHint +
      taskRules;

    const compactBaseSystemPrompt =
      this.systemPrompt +
      installedSkillsContext +
      compactRequestedSkillsContext +
      toolContext +
      (planContext ? `\n\n## Working Plan\n${JSON.stringify(planContext, null, 2)}` : "") +
      memoryContext +
      conversationSummaryContext +
      platformHint +
      taskRules;

    const minimalBaseSystemPrompt =
      this.systemPrompt +
      toolContext +
      (planContext ? `\n\n## Working Plan\n${JSON.stringify(planContext, null, 2)}` : "") +
      memoryContext +
      platformHint +
      taskRules;

    const estimatePromptTokens = (text: string): number => {
      return Math.ceil(text.length / 4);
    };

    const calculateAgentContextTokens = (mode: "full" | "lightweight" | "chatbot"): { system: number; tools: number; skills: number; total: number } => {
      let selectedPrompt = baseSystemPrompt;
      let skillsContext = requestedSkillsContext;

      if (mode !== "full") {
        selectedPrompt = minimalBaseSystemPrompt;
        skillsContext = "";
      }

      const systemTokens = estimatePromptTokens(selectedPrompt);
      const toolsTokens = estimatePromptTokens(toolContext);
      const skillsTokens = estimatePromptTokens(skillsContext);
      return {
        system: systemTokens,
        tools: toolsTokens,
        skills: skillsTokens,
        total: systemTokens + toolsTokens + skillsTokens,
      };
    };

    const isProviderLoadError = (message: string): boolean => {
      const normalized = message.toLowerCase();
      return normalized.includes("402")
        || normalized.includes("provider returned error")
        || normalized.includes("payment")
        || normalized.includes("quota")
        || normalized.includes("context")
        || normalized.includes("too large")
        || normalized.includes("token");
    };

    const isContextOverflowError = (message: string): boolean => {
      const normalized = message.toLowerCase();
      return normalized.includes("maximum context length")
        || normalized.includes("max context")
        || normalized.includes("requested about")
        || normalized.includes("too many tokens")
        || normalized.includes("context length");
    };

    const sanitizeCap = (value: number, minimum: number, fallback: number): number => {
      if (!Number.isFinite(value)) return fallback;
      const rounded = Math.floor(value);
      return rounded >= minimum ? rounded : fallback;
    };
    const envCap = (key: string, fallback: number, minimum: number): number => {
      const parsed = Number.parseInt(process.env[key] ?? "", 10);
      return sanitizeCap(parsed, minimum, fallback);
    };
    const withOverride = (override: number | undefined, fallback: number, minimum: number): number => {
      if (override === undefined) return fallback;
      return sanitizeCap(override, minimum, fallback);
    };

    const contextCaps = options.contextCaps;
    const basMaxSystemPromptChars = envCap("AGENT_MAX_SYSTEM_PROMPT_CHARS", effectiveMode === "full" ? 120000 : 20000, 2000);
    const basMaxDynamicMemoryChars = envCap("AGENT_MAX_DYNAMIC_MEMORY_CHARS", effectiveMode === "full" ? 24000 : 0, 0);
    const basMaxContextMessages = envCap("AGENT_MAX_CONTEXT_MESSAGES", effectiveMode === "full" ? 60 : effectiveMode === "lightweight" ? 999 : 8, 1);
    const basMaxContextChars = envCap("AGENT_MAX_CONTEXT_CHARS", effectiveMode === "full" ? 120000 : 60000, 2000);
    const basMaxContextMessageChars = envCap("AGENT_MAX_CONTEXT_MESSAGE_CHARS", effectiveMode === "full" ? 12000 : 2000, 200);

    const maxSystemPromptChars = withOverride(contextCaps?.maxSystemPromptChars, basMaxSystemPromptChars, 2000);
    const maxDynamicMemoryChars = withOverride(contextCaps?.maxDynamicMemoryChars, basMaxDynamicMemoryChars, 0);
    const maxContextMessages = withOverride(contextCaps?.maxContextMessages, basMaxContextMessages, 1);
    const configuredMaxContextChars = withOverride(contextCaps?.maxContextChars, basMaxContextChars, 2000);
    const maxContextMessageChars = withOverride(contextCaps?.maxContextMessageChars, basMaxContextMessageChars, 200);

    // Model-aware context ceiling. A single hard-coded character budget is wrong in both
    // directions: 120k chars (~30k tokens) overflows a small local model - which costs a full
    // wasted round-trip plus the compact/minimal retry chain below - while capping a 200k or
    // 1M-token model at a fraction of its window, so the agent forgets its own goal with most
    // of the context sitting unused.
    //
    // Applied ONLY when the model's window is actually known. TokenCounter's own fallback for
    // an unrecognised name is the 4096-token `local` entry, and deriving a budget from that
    // would collapse the window to the 4000-char floor for every model missing from its table
    // - which is most local models and most OpenRouter slugs. An unknown model therefore keeps
    // the configured character budget, exactly as before this became model-aware.
    const CHARS_PER_TOKEN = 3.5;
    const modelDerivedMaxContextChars = (() => {
      try {
        if (!TokenCounter.findModelConfig(this.provider.model)) return undefined;
        const budget = TokenCounter.getContextBudget(this.provider.model, {
          // generateFromMessages requests up to 8192 output tokens.
          reserveOutputTokens: 8192,
          systemPromptTokens: estimatePromptTokens(baseSystemPrompt),
        });
        // A model whose whole window is smaller than the output reservation yields a negative
        // budget; that is a table/configuration mismatch, not an instruction to send nothing.
        if (budget.availableTokens <= 0) return undefined;
        return Math.max(4000, Math.floor(budget.availableTokens * CHARS_PER_TOKEN));
      } catch {
        return undefined;
      }
    })();

    const hasExplicitContextCharCap =
      contextCaps?.maxContextChars !== undefined || process.env["AGENT_MAX_CONTEXT_CHARS"] !== undefined;
    const maxContextChars = modelDerivedMaxContextChars === undefined
      ? configuredMaxContextChars
      : hasExplicitContextCharCap
        ? Math.min(configuredMaxContextChars, modelDerivedMaxContextChars)
        : modelDerivedMaxContextChars;

    if (contextCaps) {
      emit("guardrail", "Run-specific context caps applied", {
        maxSystemPromptChars,
        maxDynamicMemoryChars,
        maxContextMessages,
        maxContextChars,
        maxContextMessageChars,
      });
    }

    let finalResponse = "";
    let consecutiveToolFailures = 0;
    /**
     * Why the loop ended, when it ended badly.
     *
     * The post-run quality passes evaluate "how good is this answer" - a question that has no
     * meaning for an abort notice. They ran anyway: after the consecutive-failure guardrail
     * fired, the agent still spent two full LLM round-trips (~22s each, observed) critiquing
     * the text "Abgebrochen: 10 Versuche in Folge sind fehlgeschlagen". Pure cost, and the
     * verdict it produced was about the stop message rather than about any work.
     */
    let runAbortedEarly: string | undefined;
    const repeatedToolCalls = new Map<string, number>();
    let malformedToolCallAttempts = 0;
    let unexecutedCodeFenceNudges = 0; // Bounded retries for the "showed code instead of writing it" guardrail
    let falseCompletionClaimNudges = 0; // Bounded retries for the "narrated a fake success" guardrail
    let truncatedEmptyResponseNudges = 0; // Bounded retries for the "ran out of tokens while reasoning, said nothing" guardrail
    let toolsJustExecuted = false; // Track if tools were executed in previous iteration
    let emptyResponseAfterTools = false; // Track if we got empty response after tool execution

    // Dynamic memory retrieval used to run a full memory scan on EVERY iteration even though the
    // keyword set barely changes within a run. Cache it by keyword signature so a multi-iteration run
    // hits the database roughly once instead of once per iteration. Identical keywords always yield
    // the identical context, so this changes nothing the model sees - only how often we recompute it.
    let cachedMemoryKeywordSig: string | undefined;
    let cachedDynamicMemoryContext = "";

    this.logger.info("[RUNLOOP] Starting iteration loop", {
      maxIterations: adjustedControls.maxIterations,
      hasTaskTool,
      hasBrowserTool,
      isDateTimeQuery,
    });

    while (iterations < adjustedControls.maxIterations) {
      if (this.stopRequested) {
        emit("reasoning", "Run wurde vom Benutzer gestoppt.");
        runAbortedEarly = "user_stopped";
        break;
      }

      iterations++;
      this.logger.debug("Agent iteration", { iteration: iterations });
      emit("iteration", `Iteration ${iterations}`);

      // Checklist focus: inject the FULL checklist (compact, numbered, with status) plus a
      // short imperative instruction for the current step. Deliberately English and terse:
      // small/local models follow short English imperatives far more reliably than prose, and
      // seeing the whole list (not just the current line) keeps them oriented — without it they
      // jump ahead or redo finished steps. Reassigned each iteration; buildMessages closes over it.
      let checklistHint = "";
      if (checklistActive && this.conversation.id !== undefined) {
        try {
          const open = await this.checklistManager.nextOpen(this.conversation.id, checklistRunId);
          if (open) {
            const all = await this.db.getChecklist(this.conversation.id, checklistRunId);
            checklistHint = this.renderChecklistFocusHint(open, all, this.extractChecklistFailure(open));
            await this.checklistManager.markInProgress(open.id);
          }
        } catch (error) {
          this.logger.warn("Failed to build checklist hint", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Run journal: always-on (unless disabled), checklist-independent reminder of
      // actions already taken this run. Reassigned each iteration; buildMessages closes over it.
      const runJournalHint = runJournalEnabled ? this.renderRunJournalHint(runJournal) : "";

      const dynamicMemorySignals = [
        effectiveInput,
        ...activeSkillSlugs,
        ...toolsUsed.slice(-3),
      ];
      let dynamicMemoryContext = "";
      try {
        const memoryKeywords = this.extractMemoryKeywords(dynamicMemorySignals);
        const keywordSig = memoryKeywords.join("|");
        if (keywordSig === cachedMemoryKeywordSig) {
          // Same keywords as the previous iteration - reuse the already-retrieved context.
          dynamicMemoryContext = cachedDynamicMemoryContext;
        } else {
          dynamicMemoryContext = memoryKeywords.length > 0
            ? await this.memory.buildDynamicContextWithKeywords(memoryKeywords, this.conversation.id, 5)
            : "";
          cachedMemoryKeywordSig = keywordSig;
          cachedDynamicMemoryContext = dynamicMemoryContext;
          if (dynamicMemoryContext) {
            emit("reasoning", "Memory-Kontext abgerufen.", {
              keywords: memoryKeywords.slice(0, 5),
            });
          }
        }
      } catch (memoryError) {
        this.logger.warn("Failed to build dynamic memory context", {
          error: memoryError instanceof Error ? memoryError.message : String(memoryError),
        });
        emit("guardrail", "Memory context build failed, continuing without dynamic memory", {
          error: memoryError instanceof Error ? memoryError.message : "unknown error",
        });
      }

      const buildConversationWindow = (messageLimit: number, charLimit: number): LLMMessage[] => {
        let allMessages = this.conversation.getMessages();

        // Filter out any system messages from the conversation history
        // System messages are reconstructed fresh in buildMessages() at call time
        // Including them here would break Claude API's constraint: "System message must be at the beginning"
        allMessages = allMessages.filter((m) => m.role !== "system");

        // Add current screenshot message if one exists (it needs to be in every iteration)
        if (this.currentScreenshotMessage) {
          this.logger.debug("[BUILDMSGS] Adding stored screenshot message to conversation window");
          allMessages = [...allMessages, this.currentScreenshotMessage];
        }

        if (allMessages.length === 0) return [];

        const selected: LLMMessage[] = [];
        let usedChars = 0;
        const useCompression = effectiveMode !== "full";

        // DEBUG: Track what messages are available
        const messageRoles = allMessages.map((m) => m.role).join(",");
        this.logger.debug("[BUILDMSGS] All conversation messages", {
          totalMessages: allMessages.length,
          roles: messageRoles,
          toolMessageCount: allMessages.filter((m) => m.role === "tool").length,
          assistantMessageCount: allMessages.filter((m) => m.role === "assistant").length,
        });

        // Superseded read-only results, collapsed to a one-line note. The walk below runs
        // NEWEST-FIRST, so the first time a key is seen is the most recent (and only valid)
        // result for it; every earlier copy is stale.
        const seenDedupeKeys = new Set<string>();

        for (let index = allMessages.length - 1; index >= 0; index--) {
          const message = allMessages[index];
          if (!message) continue;

          // Tool results are CRITICAL - never skip them even if messageLimit reached
          // They contain the results that the LLM needs to process
          const isToolResult = message.role === "tool";

          if (isToolResult) {
            const metadata = typeof message.metadata === "object" && message.metadata !== null
              ? (message.metadata as Record<string, unknown>)
              : undefined;
            const dedupeKey = typeof metadata?.["dedupeKey"] === "string" ? (metadata["dedupeKey"] as string) : undefined;
            if (dedupeKey) {
              if (seenDedupeKeys.has(dedupeKey)) {
                const note =
                  "[Superseded: this result was replaced by a newer, identical read later in the conversation. " +
                  "Use that one - it reflects the current state of the file.]";
                selected.push({ ...message, content: note });
                usedChars += note.length;
                continue;
              }
              seenDedupeKeys.add(dedupeKey);
            }
          }

          // For non-tool messages, respect the limit
          if (!isToolResult && selected.length >= Math.max(1, messageLimit)) break;

          // Support both string content and array content (e.g., multimodal messages with images)
          let rawContent = "";
          let finalContent: string | LLMContent[] = message.content;

          if (typeof message.content === "string") {
            rawContent = message.content;
            finalContent = rawContent;
          } else if (Array.isArray(message.content)) {
            // Multimodal content (e.g., image + text) - pass through as-is without clipping
            // These messages are typically screenshots that need full image data
            finalContent = message.content;
            rawContent = (message.content as LLMContent[])
              .filter((c) => c.type === "text")
              .map((c) => (c as any).text || "")
              .join(" ");
          }

          let clippedContent: string | LLMContent[] = finalContent;

          // Never compress tool results or multimodal content - LLM needs complete data
          const isSystemMessage = message.role === "system";
          const isMultimodal = Array.isArray(finalContent);

          if (!isToolResult && !isSystemMessage && !isMultimodal && useCompression && rawContent.length > 1500) {
            clippedContent = rawContent.substring(0, 800) + "\n...[message compressed]";
          } else if (!isToolResult && !isSystemMessage && !isMultimodal) {
            clippedContent = this.truncateText(rawContent, Math.max(200, maxContextMessageChars));
          }
          // Tool results, system messages, and multimodal content are kept complete (no clipping)

          const nextChars = usedChars + (typeof clippedContent === "string" ? clippedContent.length : rawContent.length);
          if (selected.length > 0 && nextChars > Math.max(2000, charLimit)) break;

          selected.push({
            ...message,
            content: clippedContent,
          });
          usedChars = nextChars;
        }

        // DEBUG: Log what was selected
        const selectedRoles = selected.map((m) => m.role).join(",");
        this.logger.debug("[BUILDMSGS] Selected messages for LLM context", {
          selectedCount: selected.length,
          roles: selectedRoles,
          totalChars: usedChars,
          charLimit,
        });

        return selected.reverse();
      };

      const buildMessages = (
        mode: "full" | "compact" | "minimal",
        contextOptions?: {
          messageLimit?: number;
          charLimit?: number;
          dynamicMemoryLimit?: number;
          includeDynamicMemory?: boolean;
        }
      ): LLMMessage[] => {
        const selectedPrompt = mode === "compact"
          ? compactBaseSystemPrompt
          : mode === "minimal"
            ? minimalBaseSystemPrompt
            : baseSystemPrompt;

        const clippedPrompt = this.truncateText(selectedPrompt, Math.max(2000, maxSystemPromptChars));
        const includeDynamicMemory = contextOptions?.includeDynamicMemory ?? true;
        const clippedDynamicMemory = includeDynamicMemory
          ? this.truncateText(dynamicMemoryContext, Math.max(0, contextOptions?.dynamicMemoryLimit ?? maxDynamicMemoryChars))
          : "";

        // PROMPT CACHE PREFIX. Everything in this message is computed ONCE per run (directive,
        // tool-call protocol, tool definitions, skills, plan, memory, platform hints), so it is
        // byte-identical on every iteration and can be served from the provider's prompt cache.
        //
        // The volatile per-iteration text (dynamic memory, checklist focus, run journal) used to
        // be concatenated onto the END of this string. That single detail defeated caching
        // entirely: a cache prefix must match exactly, so appending text that changes each
        // iteration invalidated the whole system prompt every time and re-billed all of it at
        // full price. It now travels as a trailing message instead - which is also where a
        // reminder belongs, since recency is what makes a model actually follow it.
        const systemMessage: LLMMessage = {
          role: "system",
          content: clippedPrompt,
          cacheControl: "ephemeral",
        };

        const contextMessages = buildConversationWindow(
          contextOptions?.messageLimit ?? maxContextMessages,
          contextOptions?.charLimit ?? maxContextChars
        );

        const volatileSuffix = `${clippedDynamicMemory}${checklistHint}${runJournalHint}`.trim();
        const suffixMessages: LLMMessage[] = volatileSuffix
          ? [{ role: "user", content: volatileSuffix }]
          : [];

        return [systemMessage, ...contextMessages, ...suffixMessages];
      };

      let currentResponseTokens: { input?: number; output?: number; total?: number; estimated?: boolean } = {};
      // Structured tool calls from the provider's NATIVE function-calling path (when the
      // backend supports it). When populated, these are trusted over the text `[TOOL:...]`
      // parser downstream - the model never had to hand-serialize the call into prose, so
      // nothing can leak into a file's content.
      let currentNativeToolCalls: ToolCall[] | undefined;
      // Some backends (reasoning models like gpt-oss) can burn the ENTIRE completion budget
      // on their hidden "reasoning" channel and return empty `content` with finish_reason
      // "length" - the model never actually got to answer or call a tool, it just ran out of
      // room while thinking. Track this so the run loop can nudge it to stop deliberating
      // instead of silently treating an empty response as "done" (see below).
      let currentFinishReason: string | undefined;

      const generateFromMessages = async (messages: LLMMessage[]): Promise<string> => {
        // DEBUG: Log what's being sent to LLM
        const messageStructure = messages.map((m, i) => {
          let contentLength = 0;
          let hasToolMarkers = false;
          let contentPreview = "";
          let isMultimodal = false;

          if (typeof m.content === "string") {
            contentLength = m.content.length;
            hasToolMarkers = /\[TOOL:|<\|tool_call>/.test(m.content);
            contentPreview = m.content.substring(0, 50);
          } else if (Array.isArray(m.content)) {
            isMultimodal = true;
            const textParts = (m.content as LLMContent[])
              .filter((c) => c.type === "text")
              .map((c) => (c as any).text || "");
            contentPreview = textParts.join(" ").substring(0, 50);
            contentLength = textParts.join(" ").length;
          }

          return {
            index: i,
            role: m.role,
            contentLength,
            hasToolMarkers,
            contentPreview,
            isMultimodal,
          };
        });
        this.logger.info("[LLM-CALL] Sending messages to LLM", {
          messageCount: messages.length,
          structure: messageStructure,
        });

        // Give the main reasoning/tool-call turn enough room to emit large payloads
        // (e.g. a write_file `content` with a full document) without being cut off
        // mid-JSON, which produces an unterminated [TOOL:...] call the parser cannot
        // read. The adapter clamps this down to the model's real output limit, and any
        // admin-configured maxTokensOverride still takes precedence over it.
        // Offer tool definitions to the provider only when it advertises native
        // function-calling. Backends without it never see `tools` and keep using the
        // text `[TOOL:...]` protocol described in the system prompt.
        const nativeToolsEnabled = this.provider.supportsNativeTools?.() ?? false;
        const mainGenOptions: { maxTokens: number; tools?: ReturnType<Executor["getToolDefinitions"]>; signal?: AbortSignal } = {
          maxTokens: adjustedControls.maxOutputTokens,
          signal: this.abortController?.signal,
        };
        if (nativeToolsEnabled) {
          mainGenOptions.tools = this.executor.getToolDefinitions();
        }
        // Reset per-turn so a native call from a previous iteration never re-executes.
        currentNativeToolCalls = undefined;
        currentFinishReason = undefined;
        if (options.stream && this.provider.supportsStreaming()) {
          try {
            // The provider streams internally and resolves with the full response.
            // The completed response is emitted to the caller once via the break
            // paths below (options.onChunk(response)), so we do not forward per-delta
            // chunks here to avoid duplicating the content.
            const result = await this.provider.generateStream(messages, mainGenOptions);
            currentResponseTokens = {
              input: result.usage.promptTokens,
              output: result.usage.completionTokens,
              total: result.usage.totalTokens,
              estimated: result.usage.estimated === true,
            };
            currentNativeToolCalls = result.toolCalls;
            currentFinishReason = result.finishReason;
            return result.content;
          } catch (e) {
            // A dead endpoint cannot be fixed by asking it again without streaming: the
            // sync retry fails identically, doubles the wait, and buries the real cause
            // under "falling back to synchronous generation".
            if (isProviderConnectionError(e)) {
              this.logger.error(`LLM provider unreachable: ${e.message}`);
              throw e;
            }
            this.logger.warn(`Streaming failed for LLM response: ${String(e)}. Falling back to synchronous generation.`);
            const syncResult = await this.provider.generate(messages, mainGenOptions);
            currentResponseTokens = {
              input: syncResult.usage.promptTokens,
              output: syncResult.usage.completionTokens,
              total: syncResult.usage.totalTokens,
              estimated: syncResult.usage.estimated === true,
            };
            currentNativeToolCalls = syncResult.toolCalls;
            currentFinishReason = syncResult.finishReason;
            return syncResult.content;
          }
        }
        const result = await this.provider.generate(messages, mainGenOptions);
        currentResponseTokens = {
          input: result.usage.promptTokens,
          output: result.usage.completionTokens,
          total: result.usage.totalTokens,
          estimated: result.usage.estimated === true,
        };
        currentNativeToolCalls = result.toolCalls;
        currentFinishReason = result.finishReason;
        return result.content;
      };

      // Generate response with exponential backoff retry
      let response: string;
      let messages = buildMessages("full");
      let skillMode: "full" | "compact" | "minimal" = "full";

      try {
        response = await retryWithBackoff(
          async () => {
            return await generateFromMessages(messages);
          },
          DEFAULT_RETRY_CONFIG,
          { logger: this.logger, eventEmitter: this.eventEmitterV2 }
        );
      } catch (error) {
        // An intentional cancellation (Stop button, progress timeout) must propagate
        // immediately - none of the compact/minimal-context retry chains below can help
        // (and would just re-issue requests against an already-aborted signal), so bail
        // out before any of that machinery runs.
        if (isAbortError(error)) {
          throw error;
        }
        const providerError = error instanceof Error ? error.message : String(error);
        // Shrinking the prompt cannot help when nothing is listening at the endpoint -
        // and isProviderLoadError matches loosely enough (on "context", "token") that an
        // error message could otherwise trip the compact-retry chain by accident.
        if (isProviderConnectionError(error)) {
          throw error;
        }
        const canRetryCompact = compactSkillManifests.length > 0 && activeSkills.length > compactSkillManifests.length;
        if (!canRetryCompact || !isProviderLoadError(providerError)) {
          throw error;
        }

        emit("guardrail", "Provider error detected, retrying with compact skill context", {
          error: providerError,
          loadedSkills: activeSkillSlugs,
          compactSkills: compactSkillManifests.map((skill) => skill.slug),
        });

        skillMode = "compact";
        messages = buildMessages("compact");
        try {
          response = await retryWithBackoff(
            async () => {
              return await generateFromMessages(messages);
            },
            DEFAULT_RETRY_CONFIG,
            { logger: this.logger, eventEmitter: this.eventEmitterV2 }
          );
        } catch (compactError) {
          const compactProviderError = compactError instanceof Error ? compactError.message : String(compactError);
          if (!isProviderLoadError(compactProviderError)) {
            throw compactError;
          }

          emit("guardrail", "Compact retry failed, retrying with minimal prompt context", {
            error: compactProviderError,
            droppedSkillContents: activeSkillSlugs,
          });

          skillMode = "minimal";
          messages = buildMessages("minimal");
          try {
            response = await retryWithBackoff(
              async () => {
                return await generateFromMessages(messages);
              },
              DEFAULT_RETRY_CONFIG,
              { logger: this.logger, eventEmitter: this.eventEmitterV2 }
            );
          } catch (minimalError) {
            const minimalProviderError = minimalError instanceof Error ? minimalError.message : String(minimalError);
            if (!isContextOverflowError(minimalProviderError)) {
              throw minimalError;
            }

            emit("guardrail", "Minimal retry still exceeded context, retrying with aggressively truncated context", {
              error: minimalProviderError,
            });

            skillMode = "minimal";
            messages = buildMessages("minimal", {
              messageLimit: 12,
              charLimit: 24000,
              dynamicMemoryLimit: 0,
              includeDynamicMemory: false,
            });
            response = await retryWithBackoff(
              async () => {
                return await generateFromMessages(messages);
              },
              DEFAULT_RETRY_CONFIG,
              { logger: this.logger, eventEmitter: this.eventEmitterV2 }
            );
          }
        }
      }

      // Don't set finalResponse yet - we'll do it after tool processing
      // This ensures we use the cleaned response, not the raw response with [TOOL:...] markers
      // finalResponse = response;  // ← Will be set after executeToolCallsFromResponse()

      // agentTokens is a chars/4 ESTIMATE of how much of the input was system prompt/tools/
      // skills, purely informational (a breakdown of what's already inside llmTokens.input
      // below) - it must never be added on top of the provider's real usage. It previously
      // was (see git history), which double-counted the system prompt on every single
      // iteration - for a CodingAgent-sized system prompt (6-16k+ chars) that inflated the
      // displayed "Combined Total" by 1,700-4,000+ tokens per call, every call.
      const agentContextTokens = calculateAgentContextTokens(effectiveMode);

      emit("decision", "LLM response received", {
        iteration: iterations,
        responseLength: response.length,
        hasToolCallMarker: /\[TOOL:/.test(response) || response.includes("<|tool_call>call:"),
        llmTokens: {
          input: currentResponseTokens.input,
          output: currentResponseTokens.output,
          total: currentResponseTokens.total,
          // Local OpenAI-compatible servers often omit usage entirely; the provider then
          // approximates it. Flagged so the UI can mark the number as an estimate rather
          // than presenting a guess as a measurement.
          estimated: currentResponseTokens.estimated === true,
        },
        agentTokens: agentContextTokens,
      });

      // Phase 2 cost governor: accumulate this call's cost and surface the running
      // total. When the budget is crossed we warn once; we only stop the run if
      // the user explicitly opted into costGovernorStop.
      if (this.costTracker) {
        const decision = this.costTracker.record({
          inputTokens: currentResponseTokens.input ?? 0,
          outputTokens: currentResponseTokens.output ?? 0,
          model: this.provider.model,
        });
        emit("decision", "Cost usage updated", {
          costUsd: decision.totals.costUsd,
          totalTokens: decision.totals.totalTokens,
          calls: decision.totals.calls,
          thresholdUsd: decision.thresholdUsd,
          overBudget: decision.overBudget,
          model: this.provider.model,
        });
        if (decision.justCrossed) {
          emit("guardrail", "Cost budget threshold reached", {
            costUsd: decision.totals.costUsd,
            thresholdUsd: decision.thresholdUsd,
            action: adjustedControls.costGovernorStop ? "stopping" : "warning_only",
          });
        }
        if (decision.overBudget && adjustedControls.costGovernorStop) {
          finalResponse = this.buildBudgetStopMessage(decision.totals.costUsd, decision.thresholdUsd);
          break;
        }
      }

      // CRITICAL: Detect and handle empty responses after tool execution
      // This is a common issue with smaller/local models that go silent after seeing tool results
      const responseIsEmpty = response.trim().length === 0;
      if (responseIsEmpty && toolsJustExecuted && !emptyResponseAfterTools && iterations < adjustedControls.maxIterations) {
        this.logger.warn("[RUNLOOP] Model returned empty response after tool execution, attempting recovery", {
          iteration: iterations,
          toolsJustExecuted,
        });

        emit("guardrail", "Modell antwortete leer nach Tool-Ausfuehrung, versuche erneut mit expliziter Aufforderung", {
          iteration: iterations,
        });

        // Add an explicit prompt forcing the model to respond based on tool results. When a
        // checklist is active there are still steps to do, so steer to CONTINUE the plan (act
        // on the current step) rather than to wrap up — otherwise the model treats the last
        // tool result as the final answer and later steps never get done.
        const recoveryPrompt: LLMMessage = {
          role: "user",
          content: checklistActive
            ? "You executed the tools. Briefly note what they returned, then CONTINUE with the current checklist step shown above: if that step requires an action (write a file, send a message, fetch data), call the appropriate tool now. Do not stop until every checklist step is done."
            : "You executed the tools. Please provide a concise response based on their results. What information did they return? How does it answer the original question?",
          metadata: { internal: true, kind: "empty_response_recovery" },
        };
        await this.conversation.addMessage(recoveryPrompt);
        this.history.add(recoveryPrompt, "empty_response_recovery");
        emit("internal_instruction", "Fordere das Modell zu einer Antwort anhand der Tool-Ergebnisse auf...", {
          kind: "empty_response_recovery",
        });

        // Mark that we've attempted recovery once
        emptyResponseAfterTools = true;

        // Retry the LLM call
        try {
          messages = buildMessages("full");
          response = await generateFromMessages(messages);
          this.logger.info("[RUNLOOP] Recovery retry succeeded", {
            iteration: iterations,
            newResponseLength: response.length,
          });
          emit("decision", "Wiederholungsversuch erfolgreich", {
            iteration: iterations,
            recoveredResponseLength: response.length,
          });
        } catch (recoveryError) {
          this.logger.error("[RUNLOOP] Recovery retry failed", {
            iteration: iterations,
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          });
          emit("guardrail", "Wiederholungsversuch fehlgeschlagen, fahre mit leerer Antwort fort", {
            error: recoveryError instanceof Error ? recoveryError.message : "unknown error",
          });
        }
      }

      // === NEW OPTION B: Early Tool-Call Extraction & Execution ===
      // Extract and execute tool calls BEFORE adding response to conversation
      // This ensures the conversation and chat only see cleaned response text
      this.logger.info("[RUNLOOP] Starting early tool-call extraction", { iteration: iterations });

      // Pull any <think>/```thinking```/[THINKING] block out of the raw response before it
      // becomes the visible assistant message, and surface it as its own "thinking" event
      // so the UI can render it distinctly instead of leaving raw reasoning markup in the
      // chat bubble (or, previously, dropping it silently - nothing called this parser).
      const thinkParseResult = this.thinkBlockParser.parse(response);
      if (thinkParseResult.thinkBlocks.length > 0) {
        emit(
          "thinking",
          `Agent hat nachgedacht (${thinkParseResult.statistics.thinkingDepth}, ${thinkParseResult.thinkBlocks.length} Block(s))`,
          {
            thinkBlocks: thinkParseResult.thinkBlocks.map((block) => ({ ...block, status: "complete" as const })),
            isStreaming: false,
          }
        );
        response = thinkParseResult.remainingContent;
      }

      // CRITICAL FIX: Add assistant message FIRST, before tool execution
      // This ensures proper message ordering for the LLM:
      // User -> Assistant -> Tool Results -> (next iteration or exit)
      // Without this, the LLM sees tool results without an assistant message that called them
      // This row exists so the LLM sees the turn that issued the tool calls; it is the raw
      // model output, markers and all. The user-facing version is written separately by
      // emitDisplayText below, so mark this one as context-only and let the UI skip it. The UI
      // used to render it, which is why an assistant turn containing "[TOOL:...]" showed up as
      // a tool box with the prose lost. Rows written before this flag existed carry no marker
      // and keep their old rendering.
      const assistantMetadata: Record<string, unknown> = { llmOnly: true };
      if (options.localMessageId) {
        assistantMetadata.localMessageId = options.localMessageId;
      }
      const assistantMessage: LLMMessage = {
        role: "assistant",
        content: response,
        metadata: assistantMetadata,
      };
      await this.conversation.addMessage(assistantMessage);
      this.history.add(assistantMessage);

      this.logger.info("[RUNLOOP] Added assistant message to conversation (before tool execution)", {
        iteration: iterations,
        hasToolMarkers: /\[TOOL:/.test(response) || response.includes("<|tool_call>call:"),
        responseLength: response.length,
      });

      // Now extract and execute tools (which will add results after the assistant message)
      const { resultMap: toolResultsMap, cleanedResponse, browserToolsCount, journalEntries } = await this.executeToolCallsFromResponse(
        response,
        adjustedControls,
        options,
        emit,
        iterations,
        repeatedToolCalls,
        currentNativeToolCalls,
        currentFinishReason === "length"
      );

      if (runJournalEnabled && journalEntries.length > 0) {
        runJournal.push(...journalEntries);
        if (runJournal.length > 30) runJournal.splice(0, runJournal.length - 30);
      }

      this.logger.info("[RUNLOOP] Tool-call extraction and execution complete", {
        iteration: iterations,
        toolsExecuted: toolResultsMap.size,
        cleanedLength: cleanedResponse.length,
        browserToolsCount,
        hasScreenshot: !!this.currentScreenshotMessage,
      });

      if (browserToolsCount > 0 && this.currentScreenshotMessage) {
        screenshotCapturedThisRun = true;
      }

      // Update finalResponse to cleaned version (for reflection, final output, etc.)
      finalResponse = cleanedResponse;

      // Mark that tools were just executed so we can detect if the next iteration returns empty
      if (toolResultsMap.size > 0) {
        toolsJustExecuted = true;
        emptyResponseAfterTools = false; // Reset recovery flag for this execution batch

        // Track consecutive iterations where EVERY executed tool call failed - the real
        // signal that the agent is stuck retrying the same broken approach (e.g. the same
        // file write failing again and again), distinct from maxRepeatedToolCall which only
        // catches byte-identical repeats and lets a slightly-varied retry through forever.
        // Resets the moment anything succeeds. The counter and its cap already existed in
        // config (AGENT_MAX_TOOL_FAILURES / maxConsecutiveToolFailures, with a settings-UI
        // description already promising this exact stop) but were never actually enforced.
        const anyToolSucceeded = Array.from(toolResultsMap.values()).some((r) => r.success);
        consecutiveToolFailures = anyToolSucceeded ? 0 : consecutiveToolFailures + 1;

        if (consecutiveToolFailures >= adjustedControls.maxConsecutiveToolFailures) {
          // Name the actual errors. "10x in Folge ohne Erfolg" on its own says nothing about
          // WHY, and the failing calls are almost always the same single mistake repeated -
          // which is precisely the thing the user needs to see to fix it.
          const failureReasons = [...new Set(
            Array.from(toolResultsMap.values())
              .filter((r) => !r.success && r.error)
              .map((r) => String(r.error).replace(/\s+/g, " ").slice(0, 200))
          )].slice(0, 3);

          this.logger.warn("[RUNLOOP] Stopping after too many consecutive tool failures", {
            consecutiveFailures: consecutiveToolFailures,
            maxAllowed: adjustedControls.maxConsecutiveToolFailures,
            failureReasons,
          });
          emit("guardrail", `Abgebrochen: ${consecutiveToolFailures}x in Folge ohne Erfolg`, {
            consecutiveFailures: consecutiveToolFailures,
            maxAllowed: adjustedControls.maxConsecutiveToolFailures,
            failureReasons,
          });
          const errorDetail = failureReasons.length > 0
            ? `\n\nLetzte Fehler:\n${failureReasons.map((reason) => `- ${reason}`).join("\n")}`
            : "";
          const stopNote = `\n\n_Abgebrochen: ${consecutiveToolFailures} Versuche in Folge sind fehlgeschlagen, ohne dass sich etwas geändert hat._${errorDetail}`;
          finalResponse = `${cleanedResponse}${stopNote}`;
          toolsJustExecuted = false;
          runAbortedEarly = "consecutive_tool_failures";
          break;
        }
      }

      // Capture this iteration's fresh evidence for later checklist verification. Doing it
      // here — not at loop end — means early steps keep their proof even after their tool
      // results have scrolled out of the LLM context window.
      if (checklistActive && (toolResultsMap.size > 0 || cleanedResponse.trim().length > 0)) {
        const toolEvidence = Array.from(toolResultsMap.values())
          .map((r) => {
            try {
              return typeof r?.data === "string" ? r.data : JSON.stringify(r?.data ?? r);
            } catch {
              return String(r);
            }
          })
          .join("\n");
        const entry = [
          cleanedResponse.trim() ? `[assistant] ${cleanedResponse.trim()}` : "",
          toolEvidence ? `[tools] ${toolEvidence}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        if (entry) {
          checklistEvidenceLog.push(`--- iteration ${iterations} ---\n${entry}`);
          checklistEvidencePushes++;
          // Bound memory/token growth: keep the most recent slice of the run's evidence.
          if (checklistEvidenceLog.length > 40) checklistEvidenceLog.shift();
        }
      }

      // Mid-run pointer advance: while the model is still working, opportunistically check
      // off the current open step(s) whose work is already finished, so the focus hint tracks
      // real progress instead of staying stuck on step 1 until the very end (which confused
      // the model and caused double work). Non-destructive — advances only on a clear `done`,
      // never consumes an attempt or marks failure. Bounded to a few advances per iteration to
      // cap verifier cost; the end-of-loop verification handles anything still open.
      if (
        checklistActive &&
        this.conversation.id !== undefined &&
        cleanedResponse.trim().length > 0 &&
        checklistEvidencePushes > checklistLastAdvanceAt && // only when fresh evidence arrived since the last check
        Date.now() - checklistLastVerifyAtMs >= (options.checklistMinVerifyIntervalMs ?? 0)
      ) {
        checklistLastAdvanceAt = checklistEvidencePushes;
        checklistLastVerifyAtMs = Date.now();
        try {
          const evidence = this.compileChecklistEvidence(cleanedResponse, checklistEvidenceLog);
          for (let advances = 0; advances < 3; advances++) {
            const open = await this.checklistManager.nextOpen(this.conversation.id, checklistRunId);
            if (!open) break;
            const advanced = await this.checklistManager.tryAdvanceDuringRun(open, effectiveInput, evidence, this.verifier);
            if (!advanced) break;
            const snapshot = await this.db.getChecklist(this.conversation.id, checklistRunId);
            emit("checklist", `Schritt erledigt: ${open.title}`, {
              phase: "progress",
              runId: checklistRunId,
              item: { index: open.stepIndex, title: open.title, status: "done" },
              total: snapshot.length,
              doneCount: snapshot.filter((i) => i.status === "done").length,
              items: snapshot.map((i) => ({ index: i.stepIndex, title: i.title, status: i.status })),
            });
          }
        } catch (error) {
          this.logger.warn("Mid-run checklist advance failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // If tools were executed and the cleaned response is empty, we MUST ask for analysis
      // Empty text after tool calls means the agent only said [TOOL:...] without any message.
      // Even near iteration limit, we need the agent to actually respond about what tools found.
      const shouldAddAnalysisPrompt = toolResultsMap.size > 0 && (
        iterations < adjustedControls.maxIterations ||  // Always if we have budget
        (cleanedResponse.trim().length === 0 && iterations >= 1)  // Or if response is empty (need one more chance to answer)
      );

      if (shouldAddAnalysisPrompt) {
        const toolNames = Array.from(new Set(
          Array.from(toolResultsMap.keys())
            .map(id => {
              // Try to extract tool name from call id or result
              const result = toolResultsMap.get(id);
              if (result?.data && typeof result.data === "object") {
                const data = result.data as Record<string, unknown>;
                return data.tool as string || "unknown";
              }
              return "unknown";
            })
            .filter(name => name !== "unknown")
        )).join(", ") || `${toolResultsMap.size} tool(s)`;

        this.logger.info("[TOOL-RESULTS] Tools executed, adding analysis prompt for next iteration", {
          iteration: iterations,
          toolCount: toolResultsMap.size,
          toolNames,
          remainingIterations: adjustedControls.maxIterations - iterations,
          hasScreenshot: !!this.currentScreenshotMessage,
        });

        // Add a user message asking the model to analyze tool results
        // This is critical: without this prompt, the model might go silent after tool execution
        let analyzePrompt: LLMMessage;

        if (this.currentScreenshotMessage && browserToolsCount > 0) {
          // If we also have a screenshot, ask about that specifically
          analyzePrompt = {
            role: "user",
            content:
              "Answer my original question directly, using the screenshot and tool results above. Reply in the same language I used. Give only the answer I asked for — do not describe the tools, commands, or exit codes, and do not add headings like 'Analysis' or 'Summary'. Keep it as short as the question needs.",
            metadata: { internal: true, kind: "screenshot_analysis" },
          };
        } else {
          // For non-browser tools, ask for a direct answer — NOT a meta-analysis.
          // Requesting "analyze the results / provide a summary" made the model wrap
          // trivial answers (e.g. the current time) in Analysis/How-this-answers/Summary
          // sections. Ask for the plain answer in the user's language instead.
          analyzePrompt = {
            role: "user",
            content: checklistActive
              // Mid-checklist: a direct "answer the original question" prompt makes the model
              // finalize after one step and abandon the rest. Steer it to keep executing the plan.
              ? `The ${toolNames} tool(s) just returned results. Briefly use them for the current checklist step, then CONTINUE to the next open step — if it needs an action (write/send/fetch), call the tool now. Only give a final answer once every checklist step is done.`
              : `Answer my original question directly, using the results from the ${toolNames} tool(s) that just executed. Reply in the same language I used. Give only the answer I asked for — do not describe the tool, the command run, or exit codes, and do not add headings like 'Analysis' or 'Summary'. Keep it as short as the question needs (for a simple question, one sentence).`,
            metadata: { internal: true, kind: "tool_analysis", toolNames },
          };
        }

        await this.conversation.addMessage(analyzePrompt);
        this.history.add(analyzePrompt, "tool_results_analysis_prompt");

        // Live status note so the user sees this immediately instead of only after the
        // internal prompt round-trips through a DB reload (see metadata.internal above).
        const internalMessage = this.currentScreenshotMessage && browserToolsCount > 0
          ? "Analysiere Screenshot und Tool-Ergebnisse..."
          : `Analysiere Ergebnisse von ${toolNames}...`;
        emit("internal_instruction", internalMessage, {
          kind: this.currentScreenshotMessage && browserToolsCount > 0 ? "screenshot_analysis" : "tool_analysis",
          toolNames,
        });
      }

      // Stream the cleaned response to user (without [TOOL:...] markers)
      // The conversation history stores the raw response (with markers), but the user sees cleaned text
      if (options.stream && options.onChunk && cleanedResponse.length > 0) {
        this.logger.info("[RUNLOOP] Streaming cleaned response to user", {
          originalLength: response.length,
          cleanedLength: cleanedResponse.length,
          iteration: iterations,
        });
        options.onChunk(cleanedResponse);
      }

      // ...and record it as a row of its own, so this iteration's text keeps its place in the
      // transcript between the tool calls around it instead of being merged into one block of
      // text at the end. Runs without streaming still get the row.
      if (cleanedResponse.length > 0) {
        const displayId = emitDisplayText(cleanedResponse);
        if (displayId) {
          lastDisplayMessageId = displayId;
          lastDisplayText = cleanedResponse;
        }
      }

      // If no tool calls were found, we're normally done — UNLESS an active checklist
      // still has open steps. Then we verify the current step against the evidence and
      // either advance (verified), accept (unverified+soft), or retry/skip (failed) so
      // the run doesn't stop with goals still outstanding.
      if (toolResultsMap.size === 0) {
        // Guardrail: a reasoning-capable backend (e.g. gpt-oss) burned its whole completion
        // budget on the hidden reasoning channel and never produced any content or tool call
        // at all - finish_reason "length" with an empty response. Letting this fall through
        // silently ends the turn with nothing done and no explanation. Nudge the model to
        // stop deliberating and act directly; this also shortens the context it's reasoning
        // over on retry (the previous, token-burning turn), which alone often breaks the loop.
        if (
          currentFinishReason === "length" &&
          response.trim().length === 0 &&
          (!currentNativeToolCalls || currentNativeToolCalls.length === 0) &&
          truncatedEmptyResponseNudges < 2
        ) {
          truncatedEmptyResponseNudges++;
          this.logger.warn("[TOOL-CALLS] Model exhausted its token budget reasoning and produced nothing, nudging", {
            attempt: truncatedEmptyResponseNudges,
          });
          emit("guardrail", "Modell hat Budget beim Nachdenken verbraucht ohne Ergebnis — fordere direktes Handeln an", {
            attempt: truncatedEmptyResponseNudges,
          });
          const nudgePrompt: LLMMessage = {
            role: "user",
            content:
              `Your last response ran out of room while you were still reasoning and produced no answer and no tool call - nothing happened. ` +
              `Stop deliberating and act now: pick ONE concrete next step (e.g. write ONE file) and emit its tool call immediately, ` +
              `without narrating your reasoning first. Do the smallest useful action now, not the whole task at once.`,
            metadata: { internal: true, kind: "truncated_empty_response_nudge" },
          };
          await this.conversation.addMessage(nudgePrompt);
          this.history.add(nudgePrompt, "truncated_empty_response_nudge");
          emit("internal_instruction", "Fordere direktes Handeln statt langem Nachdenken an...", {
            kind: "truncated_empty_response_nudge",
          });
          continue;
        }

        // Guardrail: the model showed a file's worth of code in a plain ``` fence instead
        // of emitting the [TOOL:filesystem action=write ...] block, so nothing was written.
        // Nudge it once or twice to actually call the tool before giving up and letting the
        // fence stand as the final (non-functional) answer.
        const unexecutedFence = this.detectUnexecutedCodeFence(response);
        if (unexecutedFence && unexecutedCodeFenceNudges < 2) {
          unexecutedCodeFenceNudges++;
          this.logger.warn("[TOOL-CALLS] Detected unexecuted code fence, nudging model to write it", {
            language: unexecutedFence.language,
            lineCount: unexecutedFence.lineCount,
            attempt: unexecutedCodeFenceNudges,
          });
          emit("guardrail", "Code wurde angezeigt statt geschrieben — fordere echten Tool-Call an", {
            language: unexecutedFence.language,
            lineCount: unexecutedFence.lineCount,
            attempt: unexecutedCodeFenceNudges,
          });
          const nudgePrompt: LLMMessage = {
            role: "user",
            content:
              `You just showed a ${unexecutedFence.language} code block instead of writing it. Showing code in a markdown fence does nothing — no file is created. ` +
              `Emit the actual tool call now using the block form:\n\n` +
              `[TOOL:filesystem action=write path=<the file path>]\n<the exact same content, verbatim, no markdown fence>\n[/TOOL]\n\n` +
              `Do this now — do not describe it, do not show it as a code block again.`,
            metadata: { internal: true, kind: "unexecuted_code_fence_nudge" },
          };
          await this.conversation.addMessage(nudgePrompt);
          this.history.add(nudgePrompt, "unexecuted_code_fence_nudge");
          emit("internal_instruction", "Fordere Datei-Schreibvorgang statt Codeanzeige an...", {
            kind: "unexecuted_code_fence_nudge",
          });
          continue;
        }

        // Guardrail: the model claimed in prose that a tool ran / files were submitted, but
        // emitted no marker and no native tool_call - nothing actually happened. Nudge it to
        // emit the real call instead of letting the false claim stand as the final answer.
        const falseCompletionClaim = this.detectFalseCompletionClaim(response);
        if (falseCompletionClaim && falseCompletionClaimNudges < 2) {
          falseCompletionClaimNudges++;
          this.logger.warn("[TOOL-CALLS] Detected false completion claim with no tool call, nudging model", {
            attempt: falseCompletionClaimNudges,
          });
          emit("guardrail", "Abschluss ohne echten Tool-Call behauptet — fordere echte Ausführung an", {
            attempt: falseCompletionClaimNudges,
          });
          const nudgePrompt: LLMMessage = {
            role: "user",
            content:
              `Your last response claims something was done (a tool ran, files were submitted/created) but you did not actually emit a tool call - no [TOOL:...] marker was present, so NOTHING happened. ` +
              `Claiming completion without emitting the marker is a critical failure. ` +
              `If you meant to write a file, emit it now using the block form:\n\n` +
              `[TOOL:filesystem action=write path=<the file path>]\n<the exact content, verbatim>\n[/TOOL]\n\n` +
              `Only use a tool name that is actually in your tool list - do not invent or misuse one (e.g. "gateway" sends outbound messages, it does not write files). ` +
              `Do this now — do not describe or claim it again.`,
            metadata: { internal: true, kind: "false_completion_claim_nudge" },
          };
          await this.conversation.addMessage(nudgePrompt);
          this.history.add(nudgePrompt, "false_completion_claim_nudge");
          emit("internal_instruction", "Fordere echte Tool-Ausführung statt Behauptung an...", {
            kind: "false_completion_claim_nudge",
          });
          continue;
        }

        if (checklistActive && this.conversation.id !== undefined) {
          const open = await this.checklistManager.nextOpen(this.conversation.id, checklistRunId);
          if (open) {
            const evidence = this.compileChecklistEvidence(finalResponse, checklistEvidenceLog);
            const res = await this.checklistManager.verifyAndMark(open, effectiveInput, evidence, this.verifier);
            const attemptsNow = (open.attempts ?? 0) + 1;
            const remaining = await this.checklistManager.nextOpen(this.conversation.id, checklistRunId);
            const snapshot = await this.db.getChecklist(this.conversation.id, checklistRunId);
            emit("checklist", `Schritt geprüft: ${open.title}`, {
              phase: "progress",
              runId: checklistRunId,
              item: { index: open.stepIndex, title: open.title, status: res.status },
              failures: res.failures.slice(0, 3),
              total: snapshot.length,
              doneCount: snapshot.filter((i) => i.status === "done").length,
              items: snapshot.map((i) => ({ index: i.stepIndex, title: i.title, status: i.status })),
            });

            const accepted = res.status === "done" || (res.status === "unverified" && checklistCfg.skippedPolicy === "soft");
            if (accepted) {
              // Step resolved (done, or unverified accepted under soft policy) — loop
              // continues to the next open step or exits below when none remain.
              if (remaining) continue;
            } else {
              // failed, or unverified under strict policy: retry until the attempt budget
              // is exhausted, then skip so the run can make progress on later steps.
              if (attemptsNow >= checklistCfg.maxItemAttempts) {
                await this.checklistManager.skip(open.id);
                const skipSnapshot = await this.db.getChecklist(this.conversation.id, checklistRunId);
                emit("checklist", `Schritt übersprungen (Limit erreicht): ${open.title}`, {
                  phase: "progress",
                  runId: checklistRunId,
                  item: { index: open.stepIndex, title: open.title, status: "skipped" },
                  total: skipSnapshot.length,
                  doneCount: skipSnapshot.filter((i) => i.status === "done").length,
                  items: skipSnapshot.map((i) => ({ index: i.stepIndex, title: i.title, status: i.status })),
                });
              } else {
                // Re-open for another attempt AND inject a concrete repair instruction so the
                // model knows exactly WHAT to fix — the checklist hint alone often left it
                // guessing, so a failed step was retried blindly and then skipped. English on
                // purpose: every model understands it reliably regardless of the chat language.
                await this.checklistManager.markInProgress(open.id);
                const failureLines = res.failures.slice(0, 3).map((f) => `- ${f}`).join("\n");
                const repairPrompt: LLMMessage = {
                  role: "user",
                  content:
                    `The step "${open.title}" is NOT complete yet. Its acceptance criterion was checked against the work so far and it did not pass.\n\n` +
                    `Acceptance criterion:\n${open.acceptanceCriteria ?? open.title}\n\n` +
                    (failureLines
                      ? `What is still missing / wrong:\n${failureLines}\n\n`
                      : `The required result could not be found in the work done so far.\n\n`) +
                    `Do exactly this now: take the concrete action(s) needed to satisfy this step (call the appropriate tool if the step requires producing, writing, sending, or fetching something — do not just describe it). Focus on this single step only, then stop.`,
                  metadata: { internal: true, kind: "checklist_repair" },
                };
                await this.conversation.addMessage(repairPrompt);
                this.history.add(repairPrompt, "checklist_repair_prompt");
                emit("internal_instruction", `Schritt wird repariert: ${open.title}`, {
                  kind: "checklist_repair",
                  failures: res.failures.slice(0, 3),
                });
              }
              continue;
            }
          }
        }
        this.logger.info("[RUNLOOP] No tool calls found, exiting loop", { iteration: iterations });
        toolsJustExecuted = false; // Reset flag since no tools were executed
        break; // No tool calls, we're done
      }

      // === OPTION B: Tool calls executed above in executeToolCallsFromResponse() ===
      // Legacy multi-call batch execution removed (was lines 3159-3266).
      // All tool extraction and execution now happens BEFORE response streaming.
      // If toolResultsMap has entries (toolResultsMap.size > 0), tools were already handled above.

      // Text alongside a batch of tool-call markers (e.g. "Ich werde jetzt einen Screenshot
      // erstellen...") is announcement text the model wrote BEFORE the tools ran, not a
      // result-aware summary - it never mentions what the tools actually returned because it
      // can't yet know. This used to be treated as the final answer whenever more than one
      // browser tool fired in the same turn (launch -> goto -> screenshot -> close routinely
      // does), which silently discarded the real results and left the user with only the
      // "I'm about to..." sentence and no confirmation, screenshot reference, or error report.
      // Always give the model another turn to see the tool results and respond in words,
      // bounded by the normal iteration budget and the no-text-produced fallback below.
      this.logger.info("[RUNLOOP] Tools executed, continuing to next iteration for the model's response", {
        iteration: iterations,
        toolCount: toolResultsMap.size,
        browserToolsCount,
        cleanedResponseLength: cleanedResponse.length,
      });
      continue; // Go to next iteration with tool results in conversation
    }

    // Phase 3: Ensure agent always responds - generate fallback if needed.
    // isBlankResponse also catches content-free separators like "---" that a
    // naive length check would let through (see isBlankResponse).
    if (this.isBlankResponse(finalResponse)) {
      this.logger.warn("[PHASE3] Final response is empty/blank, generating fallback response", {
        iterations,
        maxIterations: adjustedControls.maxIterations,
        toolsUsedCount: toolsUsed.length,
      });

      const toolResults: Array<{ toolName: string; success: boolean; error?: string }> = toolsUsed.map(
        (toolName) => ({
          toolName,
          success: true, // We don't track individual success here, assume success
        })
      );

      finalResponse = await this.fallbackResponseGenerator.generateResponse({
        userInput: effectiveInput,
        attemptsSoFar: iterations,
        toolsExecuted: toolResults,
        errors: [],
        conversationHistory: this.conversation.getMessages(),
        state: { maxIterationsReached: iterations >= adjustedControls.maxIterations },
      });

      emit("guardrail", "Fallback response generated (no response after all iterations)", {
        iterations,
        maxIterations: adjustedControls.maxIterations,
        fallbackResponseLength: finalResponse.length,
      });

      this.logger.info("[PHASE3] Fallback response generated successfully", {
        length: finalResponse.length,
        preview: finalResponse.substring(0, 100),
      });
    }

    // === SESSION CHECKLIST: final report ===
    // Emit the terminal checklist state and, when steps ended unresolved or unverified,
    // append an honest status line instead of letting the run read as fully "done".
    if (checklistActive && this.conversation.id !== undefined) {
      try {
        const finalItems = await this.db.getChecklist(this.conversation.id, checklistRunId);
        const doneCount = finalItems.filter((i) => i.status === "done").length;
        const unresolved = finalItems.filter((i) => i.status !== "done");
        emit("checklist", `Checkliste abgeschlossen (${doneCount}/${finalItems.length}).`, {
          phase: "done",
          runId: checklistRunId,
          total: finalItems.length,
          doneCount,
          items: finalItems.map((i) => ({ index: i.stepIndex, title: i.title, status: i.status })),
        });
        if (unresolved.length > 0 && finalResponse.trim().length > 0) {
          const lines = unresolved.map((i) => {
            const label =
              i.status === "unverified" ? "unbestätigt" : i.status === "skipped" ? "übersprungen" : i.status;
            return `- ${i.stepIndex + 1}. ${i.title} (${label})`;
          });
          finalResponse +=
            `\n\n---\n**Checkliste: ${doneCount}/${finalItems.length} erledigt.** Offen/unbestätigt:\n${lines.join("\n")}`;
        }
      } catch (error) {
        this.logger.warn("Failed to emit checklist final report", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    /**
     * What actually happened with the tools, handed to the quality passes as fact.
     *
     * Reflection only ever saw the response TEXT, so it graded prose. That misses the failure
     * mode that matters most here: an answer that reports work it did not manage to do, because
     * the writes behind it failed. The run journal already records success per tool call - it
     * just was never shown to the evaluator.
     */
    const failedActions = runJournal.filter((entry) => !entry.success);
    const toolOutcomeContext = failedActions.length > 0
      ? `; failedToolCalls=${failedActions.length} of ${runJournal.length} (${[
          ...new Set(failedActions.map((entry) => entry.toolName)),
        ].join(", ")}); IMPORTANT: if the response claims work that these failed calls were meant to perform, that is a factual error - rate it poor`
      : runJournal.length > 0
        ? `; allToolCallsSucceeded=${runJournal.length}`
        : "";

    // Reflection & Self-Improvement Loop
    // Evaluates response quality and iteratively improves it (up to reflectionMaxRetries times)
    let reflectionQuality: string | undefined;
    let reflectionIssues: string[] = [];
    let reflectionSuggestions: string[] = [];

    if (screenshotCapturedThisRun) {
      emit("guardrail", "Reflection skipped (screenshot response)", {
        reason: "Reflection only evaluates text and cannot see the captured image - " +
          "running it here previously produced fabricated descriptions of visual content it never saw.",
      });
    }

    if (runAbortedEarly) {
      emit("guardrail", "Reflexion uebersprungen (Run wurde abgebrochen)", {
        reason: runAbortedEarly,
        detail:
          "Die Qualitaetspasses bewerten eine Antwort. Nach einem Abbruch gibt es keine Antwort zu " +
          "bewerten - nur eine Abbruchmeldung, und die zu kritisieren kostet zwei LLM-Aufrufe ohne Nutzen.",
      });
    }

    if (!runAbortedEarly && !screenshotCapturedThisRun && adjustedControls.enableReflection && adjustedControls.reflectionMaxRetries > 0 && finalResponse.trim().length > 0) {
      // Normal reflection pass: evaluate response and optionally improve it
      for (let reflectionAttempt = 1; reflectionAttempt <= adjustedControls.reflectionMaxRetries; reflectionAttempt++) {
        let reflectionResult;
        try {
          reflectionResult = await this.withTimeout(
            this.reflection.evaluate(
              effectiveInput,
              this.sanitizeFinalResponse(finalResponse),
              `attempt=${reflectionAttempt}; toolsUsed=${toolsUsed.join(",")}; iterations=${iterations}${toolOutcomeContext}`
            ),
            adjustedControls.qualityPassTimeoutMs,
            "reflection"
          );
        } catch (error) {
          emit("guardrail", "Reflection skipped (timeout)", {
            attempt: reflectionAttempt,
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        reflectionQuality = reflectionResult.quality;
        reflectionIssues = Array.isArray(reflectionResult.issues) ? reflectionResult.issues.slice(0, 5) : [];
        reflectionSuggestions = Array.isArray(reflectionResult.suggestions) ? reflectionResult.suggestions.slice(0, 3) : [];

        emit("decision", "Reflection evaluation complete", {
          attempt: reflectionAttempt,
          quality: reflectionResult.quality,
          shouldRetry: reflectionResult.shouldRetry,
          issues: reflectionIssues.slice(0, 3),
          inputTokens: reflectionResult.inputTokens,
          outputTokens: reflectionResult.outputTokens,
          totalTokens: reflectionResult.totalTokens,
        });

        if (!reflectionResult.shouldRetry) {
          // Quality is good enough, stop improvement attempts
          break;
        }

        const improved = reflectionResult.improvedResponse?.trim();
        if (!improved || improved === finalResponse.trim()) {
          // No meaningful improvement offered, stop attempting
          emit("guardrail", "Reflection retry skipped", {
            reason: !improved ? "no_improved_response" : "same_response",
            attempt: reflectionAttempt,
          });
          break;
        }

        // A confused (often smaller/local) reflection model sometimes echoes its own
        // evaluation object - the exact schema it was asked to produce, with quality/
        // issues/suggestions keys - into improvedResponse instead of writing prose.
        // Adopting that verbatim would show raw self-critique JSON to the user as if it
        // were the answer, so reject anything that parses as that schema.
        if (this.looksLikeReflectionSchemaLeak(improved)) {
          emit("guardrail", "Reflection improvement rejected", {
            reason: "improved_response_is_evaluation_json",
            attempt: reflectionAttempt,
          });
          break;
        }

        // Safety check: Don't replace a good response with a much shorter one
        // (could indicate reflection model is hallucinating or degrading quality)
        const isSignificantlyShorter = improved.length < finalResponse.trim().length * 0.6;
        if (isSignificantlyShorter && reflectionQuality && reflectionQuality !== "poor") {
          emit("guardrail", "Reflection improvement rejected", {
            reason: "significantly_shorter_response",
            original_length: finalResponse.trim().length,
            improved_length: improved.length,
            current_quality: reflectionQuality,
          });
          break;
        }

        // Apply improvement and loop to next attempt
        finalResponse = improved;
      }
    }

    // Meta-Review Pass (optional second reflection)
    // Validates the already-improved response and catches edge cases
    let metaReflectionQuality: string | undefined;
    let metaReflectionIssues: string[] = [];
    let metaReflectionSuggestions: string[] = [];

    if (!runAbortedEarly && !screenshotCapturedThisRun && adjustedControls.enableReflection && adjustedControls.reflectionMetaReview && finalResponse.trim().length > 0) {
      let metaReflection;
      try {
        metaReflection = await this.withTimeout(
          this.reflection.evaluate(
            effectiveInput,
            this.sanitizeFinalResponse(finalResponse),
            `type=meta-review; priorQuality=${reflectionQuality ?? "unknown"}; priorIssueCount=${reflectionIssues.length}${toolOutcomeContext}`
          ),
          adjustedControls.qualityPassTimeoutMs,
          "meta-reflection"
        );
      } catch (error) {
        emit("guardrail", "Meta reflection skipped (timeout)", {
          error: error instanceof Error ? error.message : String(error),
        });
        metaReflection = undefined;
      }

      if (metaReflection) {
      metaReflectionQuality = metaReflection.quality;
      metaReflectionIssues = Array.isArray(metaReflection.issues) ? metaReflection.issues.slice(0, 5) : [];
      metaReflectionSuggestions = Array.isArray(metaReflection.suggestions) ? metaReflection.suggestions.slice(0, 3) : [];

      emit("decision", "Meta reflection evaluation complete", {
        quality: metaReflection.quality,
        shouldRetry: metaReflection.shouldRetry,
        issues: metaReflectionIssues.slice(0, 3),
        inputTokens: metaReflection.inputTokens,
        outputTokens: metaReflection.outputTokens,
        totalTokens: metaReflection.totalTokens,
      });

      // Meta-review can suggest final improvement
      const metaImproved = metaReflection.improvedResponse?.trim();
      if (metaReflection.shouldRetry && metaImproved && metaImproved !== finalResponse.trim()) {
        finalResponse = metaImproved;
        // Use meta-review findings if they're better than initial reflection
        if (metaReflectionQuality && metaReflectionIssues.length < reflectionIssues.length) {
          reflectionQuality = metaReflectionQuality;
          reflectionIssues = metaReflectionIssues;
          reflectionSuggestions = metaReflectionSuggestions;
        }
      }
      }
    }

    // Verification Pass ("Critic" — Phase 1)
    // Checks the final response against concrete per-constraint acceptance
    // criteria. Unlike Reflection's fuzzy score, this yields a pass/fail
    // checklist; failing checks drive up to verifyMaxFixAttempts fix passes.
    if (adjustedControls.enableVerify && finalResponse.trim().length > 0) {
      try {
        const constraints = adjustedControls.verifyDeriveConstraints
          ? await this.withTimeout(
              this.verifier.deriveConstraints(effectiveInput),
              adjustedControls.qualityPassTimeoutMs,
              "verify-derive"
            )
          : [];

        if (constraints.length > 0) {
          for (let fixAttempt = 0; fixAttempt <= adjustedControls.verifyMaxFixAttempts; fixAttempt++) {
            const verifyResult = await this.withTimeout(
              this.verifier.verify(
                effectiveInput,
                this.sanitizeFinalResponse(finalResponse),
                constraints
              ),
              adjustedControls.qualityPassTimeoutMs,
              "verify"
            );

            emit("decision", "Verification complete", {
              attempt: fixAttempt,
              passed: verifyResult.passed,
              checks: verifyResult.checks.map((c) => ({ status: c.status, description: c.description })),
              failures: verifyResult.failures.slice(0, 3),
              totalTokens: verifyResult.totalTokens,
            });

            if (verifyResult.passed || !verifyResult.shouldFix) break;
            if (fixAttempt >= adjustedControls.verifyMaxFixAttempts) {
              emit("guardrail", "Verification failed after fix attempts", {
                failures: verifyResult.failures.slice(0, 5),
              });
              break;
            }

            // Ask the model to fix specifically the failing constraints.
            const fixMessages: LLMMessage[] = [
              {
                role: "system",
                content:
                  "You revise a previous answer so it satisfies the listed failing requirements. Return only the corrected answer, no commentary.",
              },
              {
                role: "user",
                content: `Original request:\n${effectiveInput}\n\nPrevious answer:\n${finalResponse}\n\nFailing requirements to fix:\n${verifyResult.failures.map((f) => `- ${f}`).join("\n")}`,
              },
            ];
            const fixResponse = await this.withTimeout(
              this.provider.generate(fixMessages, { temperature: 0.3, maxTokens: 2000 }),
              adjustedControls.qualityPassTimeoutMs,
              "verify-fix"
            );
            const fixed = fixResponse.content?.trim();
            if (!fixed || fixed === finalResponse.trim()) {
              emit("guardrail", "Verification fix skipped", { reason: "no_change" });
              break;
            }
            finalResponse = fixed;
          }
        }
      } catch (error) {
        this.logger.warn("Verification pass failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Post-Iteration Reflection Assessment
    // Even when iteration limit reached, evaluate quality for learning (no improvement possible)
    let postIterationQuality: string | undefined;
    let postIterationIssues: string[] = [];
    let postIterationSuggestions: string[] = [];

    if (!screenshotCapturedThisRun && adjustedControls.enableReflection && adjustedControls.reflectionPostIteration && finalResponse.trim().length > 0) {
      let postAssessment;
      try {
        postAssessment = await this.withTimeout(
          this.reflection.evaluate(
            effectiveInput,
            this.sanitizeFinalResponse(finalResponse),
            `type=post-iteration; reason=max_iterations_reached; totalIterations=${iterations}; qualityIfNormal=${reflectionQuality ?? "unevaluated"}`
          ),
          adjustedControls.qualityPassTimeoutMs,
          "post-iteration"
        );
      } catch (error) {
        // Neutral result: the rest of the block then does nothing (no issues to
        // store, no improvedResponse to apply), so a stalled call cannot freeze
        // the turn on its way out.
        emit("guardrail", "Post-iteration assessment skipped (timeout)", {
          error: error instanceof Error ? error.message : String(error),
        });
        postAssessment = { quality: "adequate" as const, issues: [], suggestions: [], shouldRetry: false };
      }

      postIterationQuality = postAssessment.quality;
      postIterationIssues = Array.isArray(postAssessment.issues) ? postAssessment.issues.slice(0, 5) : [];
      postIterationSuggestions = Array.isArray(postAssessment.suggestions) ? postAssessment.suggestions.slice(0, 3) : [];

      emit("decision", "Post-iteration quality assessment complete", {
        quality: postAssessment.quality,
        issues: postIterationIssues.slice(0, 3),
        reason: "max_iterations_reached",
        inputTokens: postAssessment.inputTokens,
        outputTokens: postAssessment.outputTokens,
        totalTokens: postAssessment.totalTokens,
      });

      // Apply the post-iteration improvement when the delivered answer is blank
      // or was rated "poor". This pass used to only *assess* and then discard a
      // perfectly good improvedResponse — so a "---"/empty answer stayed empty
      // even though the assessor had already written a usable reply. We only
      // adopt it in these weak cases to avoid overwriting an otherwise fine
      // answer at the very end of the run.
      const postImproved = postAssessment.improvedResponse?.trim();
      const currentIsWeak = this.isBlankResponse(finalResponse) || postIterationQuality === "poor";
      if (postImproved && currentIsWeak && postImproved !== finalResponse.trim()) {
        emit("decision", "Post-iteration improvement applied", {
          reason: this.isBlankResponse(finalResponse) ? "blank_response" : "poor_quality",
          improvedLength: postImproved.length,
        });
        finalResponse = postImproved;
      }

      // Store post-iteration learnings if quality is below threshold
      const qualityRanking = { poor: 0, adequate: 1, good: 2, excellent: 3 };
      const minQualityRanking = qualityRanking[adjustedControls.reflectionPostIterationMinQuality] ?? 1;
      const actualQualityRanking = qualityRanking[postIterationQuality as keyof typeof qualityRanking] ?? 1;

      if (adjustedControls.reflectionStoreMemory && actualQualityRanking <= minQualityRanking && postIterationIssues.length > 0) {
        const postIterationLearning = [
          "Post-Iteration Learning (Boundary Assessment)",
          `Quality: ${postIterationQuality}`,
          postIterationIssues.length > 0 ? `Issues at Boundary: ${postIterationIssues.slice(0, 3).join("; ")}` : "",
          postIterationSuggestions.length > 0 ? `For Future: ${postIterationSuggestions.slice(0, 2).join("; ")}` : "",
        ]
          .filter((part) => part.trim().length > 0)
          .join(" | ");

        await this.memory.addDurableLearningIfNovel(
          postIterationLearning,
          4, // Importance: 4/10 - boundary learnings are valuable
          this.conversation.id,
          "pending"
        );
      }
    }

    // Store Reflection Learnings in Long-Term Memory
    // Helps agent learn from its own quality evaluations
    // Note: Always use the BEST quality info (prefer meta if it ran and found fewer issues)
    if (adjustedControls.enableReflection && adjustedControls.reflectionStoreMemory && reflectionIssues.length > 0) {
      const reflectionLearning = [
        "Self-Reflection Learning",
        reflectionQuality ? `Quality: ${reflectionQuality}` : "",
        reflectionIssues.length > 0 ? `Issues: ${reflectionIssues.slice(0, 3).join("; ")}` : "",
        reflectionSuggestions.length > 0 ? `Improvements: ${reflectionSuggestions.slice(0, 2).join("; ")}` : "",
      ]
        .filter((part) => part.trim().length > 0)
        .join(" | ");

      await this.memory.addDurableLearningIfNovel(
        reflectionLearning,
        5, // Importance: 5/10 - useful learning but not critical
        this.conversation.id,
        "pending" // Manual review before using in future contexts
      );
    }

    // Add to memory
    await this.memory.addShortTerm(
      `User: ${userInput.slice(0, 100)} | Agent: ${finalResponse.slice(0, 100)}`,
      2,
      this.conversation.id
    );

    // Record skill usage metrics (P2.3). Also persisted to skill_usage so it survives
    // restarts and carries a real last-used timestamp - skillSelector's own metricsCache
    // is in-memory only and feeds the curator job's "unused for N days" check.
    for (const skillSlug of activeSkillSlugs) {
      const success = finalResponse.trim().length > 0 && !finalResponse.includes("fehlgeschlagen");
      skillSelector.recordSkillUsage(skillSlug, success, iterations);
      this.db.recordSkillUsage(skillSlug, success, iterations).catch(() => {
        // best-effort; never fail the turn over usage-tracking persistence
      });
    }

    // Prune old skill metrics periodically
    if (Math.random() < 0.01) {
      skillSelector.pruneOldMetrics();
    }

    // Record actual mode outcome for self-calibration (P3.2)
    modeDetector.recordActualComplexity(userInput, effectiveMode, iterations);

    // Phase 1: Flush any pending events before returning
    this.eventEmitterV2.flushPending();

    const responseText = this.buildNonEmptyResponse(
      this.sanitizeFinalResponse(finalResponse),
      toolsUsed,
      iterations
    );

    // Only claim the response is already on screen when it genuinely is the last display row.
    // sanitizeFinalResponse/buildNonEmptyResponse may rewrite or substitute the text, and a
    // client told to suppress a message it never received would lose the answer entirely.
    const sameAsLastDisplayRow =
      lastDisplayText !== undefined &&
      lastDisplayText.replace(/\s+/g, " ").trim() === responseText.replace(/\s+/g, " ").trim();

    return {
      response: responseText,
      iterations,
      toolsUsed,
      conversationId: this.conversation.id,
      ...(sameAsLastDisplayRow ? { displayMessageId: lastDisplayMessageId } : {}),
      ...(checklistActive ? { checklistRunId } : {}),
      ...(runJournalEnabled ? { runJournal } : {}),
    };
  }

  /**
   * Guarantees the run returns *something* readable.
   *
   * A model that answers with nothing but a tool call - common with smaller local models,
   * which often go quiet once they see the tool result - left finalResponse empty. The
   * chat then appended an empty assistant bubble: from the user's side the agent had
   * visibly executed tools and then simply never answered, with no error to explain it.
   * Reporting what actually ran is both honest and more useful than silence.
   */
  /** User-facing message when the cost governor stops a run over budget. */
  private buildBudgetStopMessage(costUsd: number, thresholdUsd: number): string {
    return [
      `Ich habe diesen Lauf gestoppt: die geschätzten Kosten (${costUsd.toFixed(4)} USD) haben das eingestellte Budget von ${thresholdUsd.toFixed(2)} USD erreicht.`,
      "Erhöhe das Budget in den Einstellungen (Agent → Kosten-Governor) oder deaktiviere den Stopp, wenn ich weiterarbeiten soll.",
    ].join(" ");
  }

  private buildNonEmptyResponse(response: string, toolsUsed: string[], iterations: number): string {
    if (!this.isBlankResponse(response)) return response;

    this.logger.warn("Run produced no text response", { iterations, toolsUsed });

    if (toolsUsed.length === 0) {
      return "Ich habe zu dieser Anfrage keine Antwort erzeugt. Bitte formuliere sie noch einmal oder praeziser.";
    }

    const uniqueTools = Array.from(new Set(toolsUsed));
    return [
      `Ich habe ${uniqueTools.join(", ")} ausgefuehrt, danach aber keinen Antworttext erzeugt.`,
      "Die Tool-Ergebnisse stehen oben im Verlauf. Frag gezielt nach, wenn ich sie zusammenfassen soll.",
    ].join(" ");
  }

  stop(): void {
    if (this.status === "running") {
      this.stopRequested = true;
      this.abortController?.abort();
      this.logger.info("Agent stop requested");
      return;
    }
    this.status = "stopped";
    this.logger.info("Agent stopped");
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getHistory(): History {
    return this.history;
  }
}
