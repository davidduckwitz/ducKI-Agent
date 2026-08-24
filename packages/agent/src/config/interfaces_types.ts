import type { AgentHook } from "../hooks/agent-hooks.js";
import type {
  AgentRunEventSnapshot,
  AgentEventEmitter as AgentEventEmitterV2,
  AgentRunEventType
} from "../events/agent-events.js";
import type { Plan } from "../planner/planner.js";

// Re-export granular event types
export type { AgentRunEventSnapshot, AgentEventEmitterV2, AgentRunEventType };

export interface AgentOptions {
  name?: string;
  systemPrompt?: string;
  maxIterations?: number;
  timeoutMs?: number;
  enableReflection?: boolean;
  enablePlanning?: boolean;
  enableAutoMemory?: boolean;
  /**
   * Hard-disable the post-response quality passes (reflection, meta-review,
   * post-iteration, verify) regardless of DB settings. Used by the coding agent,
   * whose long, code-heavy responses make these passes slow to the point of
   * repeatedly hitting the per-pass timeout while adding little value.
   */
  disableQualityPasses?: boolean;
  /**
   * When true, skill selection (auto-scoring + related-skill expansion + SKILL.md loading) is
   * computed once and reused across every run() call on this instance, instead of being
   * recomputed from scratch on each one. Meant for a caller that issues several run() calls for
   * the SAME overall task (the coding agent's per-attempt calls) where the relevant skill set
   * does not meaningfully change between calls - recomputing it each time is pure overhead
   * (Jaccard scoring, a BFS over related-skill chains, disk reads) for a result that is almost
   * always identical. Call resetSkillSelectionCache() when starting a genuinely new task on the
   * same instance so the next run() call re-selects instead of reusing stale skills.
   */
  stickySkillSelection?: boolean;
  /** Hooks for intercepting agent lifecycle events (Phase 1) */
  hooks?: AgentHook[];
  /**
   * Hooks that fire AFTER each tool call completes (including after self-repair).
   * These are separate from `hooks` (which fire BEFORE tool execution) because they
   * have a different context shape (see AgentHookContexts.AFTER_TOOL) and the call site
   * in agent.ts is different (after self-repair, before result formatting for the LLM).
   */
  afterToolHooks?: AgentHook[];
  /**
   * Restricts skill selection/loading to this exact set of slugs (by SkillManifest.slug). Used to
   * scope a custom bot's persona to only the skills it was given - undefined means unrestricted,
   * the existing default-agent behavior of considering every skill on disk.
   */
  allowedSkillSlugs?: string[];
  /**
   * Drops the "Keep it as short as the question needs (for a simple question, one sentence)"
   * clause from the internal post-tool-call analysis prompt (see agent.ts's analyzePrompt). That
   * clause is right for the default assistant persona but actively fights a bot whose own
   * systemPrompt asks for a specific length/tone (e.g. "always write a thorough report") - the
   * length instruction is the most recent turn in context, so the model tends to obey it over an
   * earlier system prompt. Off by default: the default persona still benefits from steering
   * short answers to be short.
   */
  respectPersonaLength?: boolean;
  /**
   * Confines memory retrieval to this agent's own conversation - no global (conversationId=null)
   * "learned facts" pool, no cross-conversation keyword search. Meant for a custom bot: its
   * knowledge should be its systemPrompt plus its own history, not whatever the default agent
   * (or any other bot) has learned elsewhere. See MemorySystem's `isolated` option.
   */
  isolatedMemory?: boolean;
  /**
   * Project-local skill manifests discovered from `.agents/skills/` or
   * `.hermes/skills/` in the git repo root. These take precedence over
   * same-slug built-in skills (project > local > external). Passed by the
   * server's buildAgentFactory; the Agent's loadSkillManifests() merges them.
   */
  projectSkillManifests?: SkillManifest[];
}

export type AgentStatus = "idle" | "running" | "paused" | "error" | "stopped";

export interface AgentRunResult {
  response: string;
  iterations: number;
  toolsUsed: string[];
  conversationId?: number;
  /**
   * Id of the display row that already carries this response. The run streams each
   * iteration's user-facing text as its own timeline row, so the final result is usually a
   * repeat of the last one - the client uses this id to recognise that and not show it twice.
   */
  displayMessageId?: string;
  /** The session-checklist run id used internally for this run, when one was created
   *  (see AgentRunOptions.existingPlan). Lets a caller that supplied a plan look up this
   *  run's checklist items afterwards (e.g. to write step-completion status back to a
   *  saved plan file) without guessing/matching by title. */
  checklistRunId?: string;
  /** Final state of this run's Run Journal (see AgentRunOptions.initialRunJournal) - lets a
   *  caller that seeded the journal (CodingAgent, across its own plan->verify->iterate
   *  attempts) carry it forward into the next run() call instead of losing it when each
   *  attempt's runLoop starts a fresh one. Undefined when the run journal is disabled. */
  runJournal?: RunJournalEntry[];
  /** Why the run ended early, when it did: "user_stopped", "consecutive_tool_failures" or
   *  "stale_read_loop". Lets a caller (e.g. the explore tool) distinguish a normal answer
   *  from an abort notice instead of pattern-matching the response text. Undefined for a
   *  run that ended on its own. */
  abortedReason?: string;
}

export interface AgentRunContextCaps {
  maxSystemPromptChars?: number;
  maxDynamicMemoryChars?: number;
  maxContextMessages?: number;
  maxContextChars?: number;
  maxContextMessageChars?: number;
  supportsImageInput?: boolean;
  supportsScreenshots?: boolean;
  maxImageSize?: number;
}

export interface AgentRunAttachment {
  name: string;
  path?: string;
  url?: string;
  mimeType?: string;
}

export interface AgentRunOptions {
  stream?: boolean;
  onChunk?: (chunk: string) => void;
  onEvent?: (event: AgentRunEvent) => void;
  contextCaps?: AgentRunContextCaps;
  /** "plan" short-circuits the run loop entirely: it only produces a structured plan
   *  via the Planner and returns it as the response, without executing any tools. */
  agentMode?: "full" | "lightweight" | "chatbot" | "plan";
  attachments?: AgentRunAttachment[];
  /** When true AND `attachments` includes an image, short-circuits the run loop into a
   *  direct vision completion: no skills, no tool docs, no planner/checklist - just the
   *  attached image(s) plus the user's prompt sent straight to the model. Set by the UI's
   *  "Bildanalyse" toggle; ignored when no image attachment is present. */
  visionOnly?: boolean;
  /** Client-side UUID for message deduplication */
  localMessageId?: string;
  /** A plan the caller already built (e.g. the user-approved plan from the UI's Plan tab).
   *  When set, the run loop uses this INSTEAD OF calling the internal Planner - the agent
   *  otherwise always re-derives its own plan from the prompt text, discarding whatever
   *  structured steps the caller already had. Also forces session-checklist step tracking
   *  for this run regardless of the global AGENT_CHECKLIST_ENABLED/min-complexity settings,
   *  since a caller-supplied plan is an explicit request to track and verify each step. */
  existingPlan?: Plan;
  /** Overrides controls.timeoutMs (AGENT_TIMEOUT_MS) for this run only. Used by plan
   *  execution to honor EXECUTION_MODE_TIMEOUT_MINUTES, which is a per-execution safety
   *  timeout distinct from the agent-wide default. */
  timeoutMsOverride?: number;
  /** Overrides checklistCfg.maxItemAttempts for this run only. Used by plan execution to
   *  honor EXECUTION_MODE_MAX_RETRIES as the retry budget for THIS plan's steps, distinct
   *  from the agent-wide AGENT_CHECKLIST_MAX_ITEM_ATTEMPTS default. */
  checklistMaxItemAttemptsOverride?: number;
  /** Minimum wall-clock gap (ms) between checklist step-verification passes during this
   *  run. Honors EXECUTION_MODE_VALIDATION_INTERVAL; the checklist otherwise re-verifies
   *  as soon as new evidence arrives, which this throttles for expensive verify passes. */
  checklistMinVerifyIntervalMs?: number;
  /** Seeds this run's Run Journal instead of starting empty - lets a caller that makes
   *  several run() calls in sequence on purpose (CodingAgent's plan->verify->iterate attempt
   *  loop) carry prior attempts' journal entries forward, so a retry after a failed verify
   *  doesn't lose the record of what it already did (see AgentRunResult.runJournal). Opt-in
   *  and per-call: regular one-shot run() callers never set this and see no behavior change. */
  initialRunJournal?: RunJournalEntry[];
  /** Called once per journal entry, at the moment the entry is created, to tag it with the
   *  caller's own notion of "current step" (e.g. CodingAgent's in-progress todo id). Optional
   *  and read-only from the run loop's perspective - a plain one-shot run() never sets this
   *  and journal entries simply carry no stepId. Called synchronously so it reflects the
   *  state exactly at that tool call, not at the end of the whole attempt. */
  getCurrentStepId?: () => string | undefined;
  /** Called once per iteration with the model's raw response text, BEFORE that response's own
   *  tool calls are validated/executed - lets a caller derive state from the response (e.g.
   *  CodingAgent scanning for its ">> PHASE: X" markers) in time for a beforeTool hook to act
   *  on it for calls in that SAME response. Optional; a plain run() never sets this. */
  onModelResponse?: (response: string) => void;
  /** The delivery channel this run's response will go out on (e.g. "discord", "telegram",
   *  "cli"), when known to the caller (gateway/chat routes). Selects a short formatting hint
   *  appended to the system prompt (see prompt/guidance-blocks.ts::platformHintGuidance) -
   *  undefined/"web" gets no hint since the default chat UI renders full markdown fine. */
  channelHint?: string;
}

export interface AgentRunEvent {
  type: AgentRunEventType; // Includes all old and new event types
  message: string;
  data?: Record<string, unknown>;
  snapshot?: any; // AgentRunEventSnapshot, made optional for backward compat
  timestamp: string;
}

export interface SkillManifest {
  slug: string;
  name: string;
  description?: string;
  path: string;
  primarySkills: string[];
  relatedSkills: string[];
  fallbackSkills: string[];
  // Hermes Pattern #1: Skill Metadata System
  category?: string;
  tags?: string[];
  scripts?: Record<string, string>;
  dependencies?: string[];
  priority?: "critical" | "high" | "medium" | "low";
  // agentskills.io spec fields
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  version?: string;
  metadata?: Record<string, string>;
  // Hermes pattern: conditional activation based on available tools/toolsets
  fallbackForToolsets?: string[];
  requiresToolsets?: string[];
  fallbackForTools?: string[];
  requiresTools?: string[];
}

export interface SkillSummary extends SkillManifest {
  content: string;
}

export interface SkillScore {
  skill: SkillManifest;
  score: number;
  overlap: number;
}

/**
 * One entry in the per-run Run Journal: a short, structured record of a single
 * tool call taken during the current run, used to remind the model what it has
 * already done (see AgentRuntimeControls.runJournalEnabled).
 */
export interface RunJournalEntry {
  iteration: number;
  toolName: string;
  summary: string;
  success: boolean;
  /** When this entry was created. Iteration numbers alone are ambiguous across CodingAgent's
   *  multiple attempts (each attempt's agent.run() restarts its own iteration count at 1), so
   *  this is the only field that orders entries unambiguously across a whole multi-attempt run. */
  timestamp: string;
  /** The actual error message when success is false - previously only the boolean survived,
   *  so a failed step's journal entry told a reader THAT it failed but never WHY, and a later
   *  attempt (or a human reviewing the run) had to re-derive the reason from the raw response
   *  text. Absent on success. Clamped short: this rides along in every follow-up prompt. */
  errorDetail?: string;
  /** The caller-supplied "current step" id at the moment this entry was created (see
   *  AgentRunOptions.getCurrentStepId) - e.g. CodingAgent's in-progress todo item. Lets a
   *  reader answer "what did step 3 actually do?" instead of only "what ran in what order".
   *  Undefined for callers that don't track steps. */
  stepId?: string;
}

export interface AgentRuntimeControls {
  // Execution
  maxIterations: number;
  /** Output-token ceiling for the main generation call (AGENT_MAX_OUTPUT_TOKENS). */
  maxOutputTokens: number;
  timeoutMs: number;
  shellToolTimeoutMs: number;
  httpToolTimeoutMs: number;
  browserToolTimeoutMs: number;
  gitToolTimeoutMs: number;
  /**
   * Per-pass timeout (ms) for the post-run quality passes: reflection, meta-reflection,
   * verify constraint-derivation, and verify/fix. Each pass is bounded independently so a
   * single stalled local-model call (e.g. LM Studio hanging) is abandoned and the turn still
   * completes, instead of freezing until the global no-progress timeout.
   * Settings key: AGENT_QUALITY_PASS_TIMEOUT_MS (default 45000).
   */
  qualityPassTimeoutMs: number;

  // Memory & Reflection
  enableAutoMemory: boolean;
  /**
   * Enable response quality evaluation and self-improvement.
   * When enabled, agent evaluates final response quality and attempts improvements.
   * - Full mode: enabled by default, allows reflectionMaxRetries improvement cycles
   * - Lightweight mode: disabled (only 5 iterations available, reflection would consume ~20%)
   * - Chatbot mode: disabled (only 1-5 iterations total, no room for reflection)
   * Cost: ~200-500 tokens per reflection + ~200-400ms latency
   * Recommended: true for full mode (improves response quality)
   * Settings key: AGENT_ENABLE_REFLECTION
   */
  enableReflection: boolean;
  /**
   * Maximum reflection improvement attempts per response (0-3).
   * Each attempt: evaluate quality, identify issues, generate improved version.
   * - 0: reflection disabled (quick response)
   * - 1: one improvement attempt (recommended, good quality/speed tradeoff)
   * - 2-3: multiple attempts (higher quality, slower, more tokens)
   * Note: Disabled in lightweight/chatbot modes regardless of this setting.
   * Settings key: AGENT_REFLECTION_MAX_RETRIES
   */
  reflectionMaxRetries: number;
  /**
   * Store reflection learnings (quality issues, improvement suggestions) in long-term memory.
   * Helps agent learn from its own self-evaluations over time.
   * Stores as "pending" memory entries requiring manual review before use.
   * Recommended: false (only enable if you want to review reflection learnings)
   * Settings key: AGENT_REFLECTION_STORE_MEMORY
   */
  reflectionStoreMemory: boolean;
  /**
   * Run secondary "meta-review" reflection after improvements.
   * Second reflection validates the already-improved response and catches edge cases.
   * Useful for complex responses where initial reflection might miss something.
   * Cost: +1 LLM call (~200-500 tokens) if enabled
   * Only runs if enableReflection=true and response passes first reflection.
   * Recommended: false (use for critical responses needing high confidence)
   * Settings key: AGENT_REFLECTION_META_REVIEW
   */
  reflectionMetaReview: boolean;
  /**
   * Run quality assessment after normal run completes (post maxIterations).
   * Even when run ends due to iteration limits, reflection can assess quality for learning.
   * Response is NOT improved (too late), but issues are stored in memory for future learning.
   * Cost: +1 LLM call (~200-500 tokens) only at end of run
   * Recommended: true (helps agent learn from its boundaries)
   * Settings key: AGENT_REFLECTION_POST_ITERATION
   */
  reflectionPostIteration: boolean;
  /**
   * Minimum quality threshold for storing post-iteration learnings.
   * Only stores issues in memory if quality is <= this level.
   * Values: "poor" | "adequate" | "good" | "excellent"
   * - "poor": Store if any quality issue found (most learning)
   * - "adequate": Store if quality <= adequate (most relevant)
   * - "good": Store if quality <= good (only bad responses)
   * Recommended: "adequate" (good balance of learning frequency)
   * Settings key: AGENT_REFLECTION_POST_ITERATION_MIN_QUALITY
   */
  reflectionPostIterationMinQuality: "poor" | "adequate" | "good" | "excellent";

  // Coding runs ("[CODING_CONTEXT]" chat + CodingAgent). These override the general
  // controls ONLY for coding work, so the normal chat agent stays untouched.
  /**
   * Iteration budget for coding runs. Coding is multi-step (write → verify → fix
   * across files); the general mode caps (5-10) cut large tasks short.
   * Settings key: AGENT_CODING_MAX_ITERATIONS
   */
  codingMaxIterations: number;
  /**
   * Run the reflection quality passes during coding. Default off: on long code
   * responses with a local model these repeatedly hit their timeout.
   * Settings key: AGENT_CODING_ENABLE_REFLECTION
   */
  codingEnableReflection: boolean;
  /**
   * Run the verify pass during coding. Default off (same reason as reflection).
   * Settings key: AGENT_CODING_ENABLE_VERIFY
   */
  codingEnableVerify: boolean;

  /**
   * Iteration cap applied when the agent runs in "lightweight" mode (short,
   * non-technical queries). Full mode uses maxIterations directly; this lets the
   * user tune the lightweight ceiling instead of the previously hard-coded 10.
   * Settings key: AGENT_LIGHTWEIGHT_MAX_ITERATIONS
   */
  lightweightMaxIterations: number;
  /**
   * Iteration cap applied when the agent runs in "chatbot" mode (trivial
   * queries). Tool round-trips (task/browser/date-time) still raise the floor so
   * a tool call and its answer both fit. Replaces the hard-coded 5/8/10 caps.
   * Settings key: AGENT_CHATBOT_MAX_ITERATIONS
   */
  chatbotMaxIterations: number;

  // Cost Governor ("Manager" — Phase 2)
  /**
   * Budget ceiling per run in USD. When the accumulated LLM cost reaches this,
   * the agent warns the user (and stops only if costGovernorStop is true).
   * 0 disables the governor (costs are still tracked). Local models cost 0.
   * Settings key: AGENT_COST_BUDGET_USD
   */
  costBudgetUsd: number;
  /**
   * When the budget is exceeded: true = stop the run, false = warn only.
   * Default false — the agent surfaces the overrun but keeps working, matching
   * the "no autonomous cost decisions without opt-in" principle.
   * Settings key: AGENT_COST_GOVERNOR_STOP
   */
  costGovernorStop: boolean;
  /**
   * Whether the agent may autonomously switch to a cheaper model when a plan's
   * estimated cost exceeds the budget. Default false — the agent only *suggests*
   * a downgrade and leaves the decision to the user.
   * Settings key: AGENT_AUTO_DOWNGRADE
   */
  autoDowngrade: boolean;

  // Verification ("Critic" — Phase 1)
  /**
   * Enable structured verification of the final response against concrete,
   * per-constraint acceptance criteria (distinct from Reflection's fuzzy score).
   * When a check fails, up to verifyMaxFixAttempts fix passes are attempted.
   * Cost: ~1 LLM call to derive constraints + ~1 to grade them, per run.
   * Settings key: AGENT_ENABLE_VERIFY
   */
  enableVerify: boolean;
  /**
   * Maximum fix attempts after a failed verification (0-3). 0 = verify and
   * report only, never rewrite the response.
   * Settings key: AGENT_VERIFY_MAX_FIX_ATTEMPTS
   */
  verifyMaxFixAttempts: number;
  /**
   * When no explicit constraints are supplied, let the Verifier derive an
   * acceptance checklist from the user request. If false and no constraints are
   * given, verification is skipped.
   * Settings key: AGENT_VERIFY_DERIVE_CONSTRAINTS
   */
  verifyDeriveConstraints: boolean;

  // Session Checklist
  /**
   * Enable the per-run session checklist: derive a checklist from the auto-plan,
   * inject the current open step each iteration, and verify each step before the
   * run ends. Default false.
   * Settings key: AGENT_CHECKLIST_ENABLED
   */
  checklistEnabled: boolean;
  /**
   * Minimum plan complexity that activates the checklist ("low"|"medium"|"high").
   * Trivial requests never get a checklist. Default "medium".
   * Settings key: AGENT_CHECKLIST_MIN_COMPLEXITY
   */
  checklistMinComplexity: "low" | "medium" | "high";
  /**
   * Max verify/repair attempts per checklist item before it is skipped. Default 2.
   * Settings key: AGENT_CHECKLIST_MAX_ITEM_ATTEMPTS
   */
  checklistMaxItemAttempts: number;
  /**
   * How an "unverified" item (all checks skipped) is treated: "soft" accepts and
   * moves on (flagged unbestätigt); "strict" retries like a failure. Default "soft".
   * Settings key: AGENT_CHECKLIST_SKIPPED_POLICY
   */
  checklistSkippedPolicy: "soft" | "strict";

  // Run Journal
  /**
   * Always-on, checklist-independent in-memory log of actions taken during a run
   * (tool + short summary + success/fail), injected into the system prompt each
   * iteration so the model does not repeat work it already did. No DB persistence.
   * Default true.
   * Settings key: AGENT_RUN_JOURNAL_ENABLED
   */
  runJournalEnabled: boolean;

  // Vision ("Observer" — Phase 4)
  /**
   * Enable the analyze_ui_layout vision tool. Needs a vision-capable model in
   * the active provider; when off, the tool returns a disabled notice instead of
   * calling the model. Default true.
   * Settings key: AGENT_ENABLE_VISION
   */
  enableVision: boolean;

  // Reasoning & Tools
  reasonerUseToolMinConfidence: number;
  maxConsecutiveToolFailures: number;
  maxRepeatedToolCall: number;
  /**
   * Consecutive iterations re-issuing the EXACT SAME read-only call set (no mutation in
   * between) before the run aborts as a non-converging loop. Catches a model stuck
   * re-reading the same files - something maxRepeatedToolCall (byte-identical single calls)
   * and maxConsecutiveToolFailures (all-failed iterations) structurally cannot.
   * Settings key: AGENT_STALE_READ_STREAK
   */
  staleReadLoopThreshold: number;

  // Self-Repair
  selfRepairEnabled: boolean;
  selfRepairMaxAttempts: number;

  // Skills
  enableAutoSkillSelection: boolean;
  autoSkillScoreThreshold: number;
  autoSkillMarginThreshold: number;
  autoSkillMinInputLength: number;
  autoSkillMinOverlap: number;
  skillBehavior: "automatic" | "active";
  autoSkillFallbackNone: boolean;
  enabledSkillAllowlist: string[];
  enabledOptionalTools: string[];
  alwaysLoadSkills?: string[];

  // ============================================================
  // PROVIDER SETTINGS (NEW)
  // ============================================================

  // Error Handling
  providerErrorRetryPolicy: "auto" | "manual";
  providerErrorMaxRetries: number;
  providerErrorRetryBackoffMs: number;
  providerErrorRetryBackoffMultiplier: number;

  // Compression
  providerCompressionThreshold: number; // % of max context
  providerAutoCompressOnError: boolean;
  providerCompressionMinChars: number;

  // Credential Rotation
  providerCredentialRotationStrategy: "auto" | "manual";
  providerMaxErrorsBeforeRotation: number;

  // Failover
  providerFailoverEnabled: boolean;
  providerFailoverStrategy: "intelligent" | "round-robin" | "random";
  providerMaxErrorsPerProvider: number;
  providerErrorResetWindowMs: number;

  // Logging
  providerLogClassifications: boolean;
  providerLogRetries: boolean;
  providerLogFailovers: boolean;
  providerDebugMode: boolean;

  // Adapter-Specific
  anthropicTimeoutMs: number;
  anthropicMaxRetries: number;
  anthropicExtendedThinkingEnabled: boolean;
  anthropicStreamingEnabled: boolean;

  geminiTimeoutMs: number;
  geminiMaxRetries: number;
  geminiSafetyThreshold: "BLOCK_NONE" | "BLOCK_LOW" | "BLOCK_MED" | "BLOCK_HIGH";

  bedrockTimeoutMs: number;
  bedrockMaxRetries: number;
  bedrockRegion: string;

  // Browser tool - applied as defaults on action=launch when the LLM/UI call omits them.
  /** Settings key: BROWSER_REUSE_SESSION - reuse the shared session instead of launching a new browser every run. */
  browserReuseSession: boolean;
  /** Settings key: BROWSER_HEADLESS_MODE */
  browserHeadless: boolean;
  /** Settings key: BROWSER_VIEWPORT_WIDTH */
  browserViewportWidth: number;
  /** Settings key: BROWSER_VIEWPORT_HEIGHT */
  browserViewportHeight: number;
  /** Settings key: BROWSER_CUSTOM_EXECUTABLE_PATH */
  browserExecutablePath: string;
  /** Settings key: BROWSER_USER_AGENT */
  browserUserAgent: string;
  /** Settings key: BROWSER_SCREENSHOT_FORMAT - jpeg is the safest default (many local vision models can't decode webp). */
  browserScreenshotFormat: "jpeg" | "png" | "webp";
  /** Settings key: BROWSER_SCREENSHOT_QUALITY */
  browserScreenshotQuality: number;
  /** Settings key: BROWSER_DISABLE_IMAGES */
  browserDisableImages: boolean;
  /** Settings key: BROWSER_BLOCK_RESOURCES */
  browserBlockResources: "none" | "tracking" | "ads" | "all";
  /** Settings key: BROWSER_DISABLE_AUTOMATION - inverted: true keeps automation hidden. */
  browserHideAutomation: boolean;
  /** Settings key: BROWSER_COOKIE_DETECTION */
  browserCookieDetection: boolean;
  /** Settings key: BROWSER_PROXY_URL */
  browserProxyUrl: string;
}

// Event Emitter for Agent lifecycle events (chunk streaming, state updates)
export interface AgentRunEventEmitter {
  emitChunk(chunk: string): void;
  emitEvent(event: AgentRunEvent): void;
}

export type AgentEventEmitter = AgentRunEventEmitter;
