export { Agent, DEFAULT_SYSTEM_PROMPT } from "./agent.js";
export type { AgentEventEmitter, SkillManifest } from "./config/interfaces_types.js";
export { AgentOptions, AgentRunResult, AgentRunEvent, AgentRunEventType, AgentRunOptions, AgentRuntimeControls } from "./config/interfaces_types.js"
export { ErrorClassifier, ErrorCategory } from "./executor/error-classifier.js";
export type { ErrorClassification } from "./executor/error-classifier.js";
// Settings exports
export { loadAgentRuntimeControls, providerSettingsToRuntimeControls } from "./config/load-runtime-controls.js";
export { createProviderSettings, loadProviderSettingsFromEnv } from "./config/provider-settings.js";
export type {
  ProviderSettings,
  ErrorClassifierConfig,
  AnthropicConfig,
  GeminiConfig,
  BedrockConfig,
} from "./config/provider-settings.js";
// Re-export from providers to avoid circular deps
export type { AdapterConfig, ProviderRouterConfig } from "@ducki/providers";
export { ConversationManager } from "./conversation/conversation.js";
export { MemorySystem } from "./memory/memory.js";
export { Planner } from "./planner/planner.js";
export type { Plan, PlanStep, ClarifyingQuestion, ClarifyingQuestionOption } from "./planner/planner.js";
export { formatPlanAsMarkdown } from "./planner/plan-tool.js";
export { Executor } from "./executor/executor.js";
export type { ToolExecutor } from "@ducki/shared";
export { Reasoner } from "./reasoner/reasoner.js";
export { Reflection } from "./reflection/reflection.js";
export { History } from "./history/history.js";
export { createWorkflowTools, type ConnectorRegistryLike } from "./workflow/workflow-tools.js";
export { createWorkflowManagementTool } from "./workflow/workflow-management-tool.js";
export { createCronjobManagementTool } from "./cronjob/cronjob-management-tool.js";
export { WorkflowEngine } from "./workflow/workflow-engine.js";
export type {
	MultiAgentRole,
	WorkflowNode,
	WorkflowEdge,
	WorkflowGraph,
	WorkflowRunSummary,
	WorkflowNodeStatus,
	WorkflowStatus,
	WorkflowNodeKind,
} from "./workflow/workflow-engine.js";
export { TaskSplitter } from "./tasks/task-splitter.js";
export type { SplitSubtask, SplitResult } from "./tasks/task-splitter.js";
export { previewSplit, commitSplit } from "./tasks/task-split-service.js";
export type { PreviewSplitResult } from "./tasks/task-split-service.js";
export { createToolFactoryTool } from "./dynamic-tools/tool-factory-tool.js";
export { createDynamicToolResolver, dynamicToolRowToDefinition } from "./dynamic-tools/dynamic-tool-resolver.js";
export { loadToolManifests, isToolActive, getCoreToolNames, parseEnabledToolNamesSetting } from "./tools/tool-registry.js";
export type { ToolManifestEntry } from "./tools/tool-registry.js";
export { createScriptTools, runScriptResultSubagent } from "./tools/script-tools.js";
export { RESERVED_TOOL_NAMES } from "./tools/reserved-tool-names.js";
export { TOOL_CALL_FORMAT_BLOCK } from "./agent.js";

// Phase 1: Hooks & Granular Events
export { HookRegistry, type AgentHook, type AgentHookResult } from "./hooks/agent-hooks.js";
export { AGENT_HOOK_NAMES, type AgentHookContexts } from "./hooks/hook-names.js";
export { EventEmitterV2, type EventEmitterV2Options } from "./events/event-emitter-v2.js";
export { AGENT_EVENT_TYPES } from "./events/agent-events.js";
export type { AgentRunEventSnapshot } from "./events/agent-events.js";
export {
  ThinkBlockEventEmitter,
  AgentQuestionEventEmitter,
} from "./events/think-block-events.js";

// Think Block Parser (Phase 1)
export { ThinkBlockParser } from "./parsers/think-block-parser.js";
export type {
  ThinkBlock,
  ToolCallReference,
  ParseResult,
} from "./parsers/think-block-parser.js";

// Phase 2: Tool Approval Policies & Input Normalization
export {
  ToolApprovalPolicy,
  type ToolApprovalRule,
  type ApprovalCheckResult,
  DenyInputPattern,
  DenyTool,
  RequireConfirmation,
  AllowedActions,
  AllowedShellCommands,
} from "./tools/tool-approval-policy.js";
export {
  InputNormalizerPipeline,
  AliasNormalizer,
  TypeCoercer,
  JSONRepairNormalizer,
  type InputNormalizer,
  type NormalizationResult,
} from "./tools/input-normalizer.js";

// Phase 3: Streaming & SDK Interfaces
export { AgentRunnerV2, createAgentRunnerV2, type AgentRunFrame } from "./agent-runner-v2.js";
export {
  createCompletionTool,
  createCodingCompletionTool,
  createReviewCompletionTool,
  type CompletionToolOptions,
} from "./tools/completion-tool.js";
export type {
  SDKTool,
  SDKToolRegistry,
  SDKLLMGateway,
  AgentIteration,
  AgentSDK,
  AgentHost,
  AgentFactory,
} from "./core/agent-sdk-interfaces.js";

// Phase 3B: Browser & Edge Runtimes
export {
  BrowserAgentRuntime,
  createBrowserAgentRuntime,
  type BrowserRuntimeConfig,
} from "./runtime/browser-sdk.js";
export {
  EdgeAgentSDK,
  handleEdgeAgentRequest,
  type EdgeRequest,
  type EdgeResponse,
} from "./runtime/edge-sdk.js";

// Performance Benchmarks
export { AgentBenchmark, type BenchmarkResult } from "./performance/benchmarks.js";
// Keep the public CodingAgent class unchanged for direct callers/tests, but route the factory used
// by the server/workflows through the compatible subclass that adds bounded failure-only
// reflection when deterministic verification repeats unchanged.
export { CodingAgent } from "./coding/coding-agent.js";
export { buildRepositorySnapshot } from "./coding/repo-snapshot.js";
export { FailureAwareCodingAgent, createFailureAwareCodingAgent as createCodingAgent } from "./coding/failure-aware-coding-agent.js";
export type { CodingAgentOptions, CodingRunOptions, CodingRunResult } from "./coding/coding-agent.js";
export { CodingRunState } from "./coding/coding-run-state.js";
export type { CodingFailureReflection, CodingFailureSnapshot, VerifyFailureUpdate } from "./coding/coding-run-state.js";
export { CodingFailureReflector } from "./coding/failure-reflector.js";
export type { CodingFailureReflectionInput } from "./coding/failure-reflector.js";
export { createScopedFilesystemTool, sanitizeCodeContent } from "./coding/scoped-filesystem-tool.js";
export { createScopedShellTool } from "./coding/scoped-shell-tool.js";
export { createScopedDiagnosticsTool } from "./coding/scoped-diagnostics-tool.js";
export { CODING_ALLOWED_SHELL_COMMANDS, condenseVerifyOutput } from "./coding/coding-agent.js";
export {
  CHECKPOINT_DIR,
  ensureCheckpointRepo,
  createCheckpoint,
  listCheckpoints,
  diffCheckpoint,
  restoreCheckpoint,
  discardNoopCheckpoint,
} from "./coding/checkpoints.js";
export type { Checkpoint, CheckpointDiff } from "./coding/checkpoints.js";
export { TodoList, createTodoTool } from "./coding/todo-tool.js";
export type { TodoItem, TodoStatus } from "./coding/todo-tool.js";
// Context compression & memory optimization
export { TokenCounter } from "./context/token-counter.js";
export type { ModelTokenConfig } from "./context/token-counter.js";
export { ContextManager } from "./context/context-manager.js";
export type { ContextManagerConfig, PruningStrategy } from "./context/context-manager.js";
// Skill bundling & advanced features
export { SkillSelector, skillSelector } from "./skill-selector/selector.js";
export type { SkillMetrics } from "./skill-selector/selector.js";
export { SkillRegistry, skillRegistry, AVAILABLE_SKILLS } from "./skill-selector/skill-registry.js";
export { jaccardSimilarity } from "./utils/text-similarity.js";
export {
  parseFrontmatter,
  normalizeFrontmatter,
  normalizeSkillContent,
  readSkillFrontmatter,
} from "./skill-selector/frontmatter.js";
export type { NormalizedSkillFrontmatter, ParsedFrontmatter } from "./skill-selector/frontmatter.js";
export { validateSkillContent, validateSkillDirectory } from "./skill-selector/validate.js";

// Plugin system (file-first bundles: data-source/script tools + skills + mappings + settings)
export {
  loadPlugins,
  listPluginSkillDirs,
  setPluginEnabled,
  readDisabledState,
  pluginsRoot,
  parsePluginManifest,
  parseOAuthConfig,
  validatePluginDir,
  PluginManifestSchema,
  OAuthConfigSchema,
  type PluginLoadResult,
  type LoadedPluginInfo,
  type PluginManifest,
  type PluginToolMapping,
  type PluginSettingSpec,
  type PluginToolContext,
  type LoadedPluginLLMProvider,
  type PluginLLMProviderConfig,
  type PluginLLMProviderSpec,
  type PluginWidgetSpec,
  type OAuthConfig,
  createAgentCapabilities,
  type AgentCapabilities,
  type AgentImageInput,
  type AgentVideoAnalysisResult,
} from "./plugins/index.js";
export type {
  ConnectorTarget,
  OutboundAttachment,
  OutboundMessage,
  InboundAttachment,
  InboundMessage,
  ConnectorStatus,
  ConnectorCapabilities,
  ConnectorWebhookRequest,
  ConnectorWebhookResponse,
  ConnectorContext,
  ConnectorAdapter,
  ConnectorModuleExports,
} from "./plugins/connector-types.js";
export type { SkillValidationResult, SkillValidationIssue } from "./skill-selector/validate.js";

// Video source fetch (YouTube/TikTok/Instagram/X + direct video links via yt-dlp)
export {
  detectPlatform,
  isKnownVideoPlatform,
  fetchVideoFromUrl,
  type VideoFetchResult,
} from "./media/video-source-fetch.js";
export { analyzeVideo, transcribeExtractedAudio, type VideoAnalysis, type VideoFrame } from "./media/video-processing.js";

// Bitcoin Puzzle Solver
export { BitcoinPuzzleService } from "./crypto/bitcoin-puzzle-service.js";
export type { SolverState, SolverConfig, PuzzleMetadata } from "./crypto/bitcoin-puzzle-service.js";
export type { AttemptRecord } from "./crypto/bitcoin-puzzle-solver.js";
