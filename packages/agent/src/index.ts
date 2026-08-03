export { Agent } from "./agent.js";
export type { AgentEventEmitter } from "./config/interfaces_types.js";
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
export type { Plan, PlanStep } from "./planner/planner.js";
export { Executor } from "./executor/executor.js";
export type { ToolExecutor } from "@ducki/shared";
export { Reasoner } from "./reasoner/reasoner.js";
export { Reflection } from "./reflection/reflection.js";
export { History } from "./history/history.js";
export { createWorkflowTools } from "./workflow/workflow-tools.js";
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
export { CodingAgent, createCodingAgent } from "./coding/coding-agent.js";
export type { CodingAgentOptions, CodingRunOptions, CodingRunResult } from "./coding/coding-agent.js";
// Context compression & memory optimization
export { TokenCounter } from "./context/token-counter.js";
export type { ModelTokenConfig } from "./context/token-counter.js";
export { ContextManager } from "./context/context-manager.js";
export type { ContextManagerConfig, PruningStrategy } from "./context/context-manager.js";
// Skill bundling & advanced features
export { SkillBundleManager, DEFAULT_SKILL_BUNDLES } from "./skill-selector/skill-bundle.js";
export type { SkillBundle } from "./skill-selector/skill-bundle.js";
export { AdvancedSkillSelector } from "./skill-selector/advanced-selector.js";
export type { SelectionContext, SelectionResult } from "./skill-selector/advanced-selector.js";
export { SkillSelectionService, skillSelectionService } from "./skill-selector/skill-selection-service.js";
export { SkillSelector, skillSelector } from "./skill-selector/selector.js";
export type { SkillMetrics } from "./skill-selector/selector.js";
export { SkillRegistry, skillRegistry, AVAILABLE_SKILLS, populateSkillBundles } from "./skill-selector/skill-registry.js";

// Bitcoin Puzzle Solver
export { BitcoinPuzzleService } from "./crypto/bitcoin-puzzle-service.js";
export type { SolverState, SolverConfig, PuzzleMetadata } from "./crypto/bitcoin-puzzle-service.js";
export type { AttemptRecord } from "./crypto/bitcoin-puzzle-solver.js";
