import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import { Executor } from "./executor/executor.js";
import { History } from "./history/history.js";
import { AgentOptions, AgentStatus, AgentRunResult, AgentRunOptions } from "./config/interfaces_types";
export declare class Agent {
    private readonly provider;
    private readonly db;
    readonly name: string;
    private status;
    private systemPrompt;
    private maxIterations;
    private timeoutMs;
    private enableReflection;
    private enablePlanning;
    private enableAutoMemory;
    private conversation;
    private memory;
    private planner;
    readonly executor: Executor;
    private reasoner;
    private reflection;
    private history;
    private logger;
    private skillsRoot;
    private stopRequested;
    private readonly maxConsecutiveToolFailures;
    private readonly maxRepeatedToolCall;
    private readonly enableAutoSkillSelection;
    private readonly autoSkillScoreThreshold;
    private readonly autoSkillMarginThreshold;
    private readonly autoSkillMinInputLength;
    private readonly autoSkillMinOverlap;
    private autoSkillSelectionAttempts;
    private autoSkillSelections;
    constructor(provider: LLMProvider, db: DatabaseService, options?: AgentOptions);
    startConversation(options?: {
        name?: string;
        projectId?: number;
    }): Promise<number>;
    loadConversation(id: number): Promise<void>;
    run(userInput: string, options?: AgentRunOptions): Promise<AgentRunResult>;
    private normalizeToolCallText;
    /**
     * Strip residual LLM special tokens from the final response so raw markup
     * is never shown to the user (e.g. Hermes <|tool_call|> fragments, im_start/end, etc.)
     */
    private sanitizeFinalResponse;
    private truncateText;
    private parseFrontmatter;
    private expandRelatedSkills;
    private loadSkillManifests;
    private loadSkillContent;
    private tokenizeForMatching;
    private scoreSkillMatch;
    private isDateTimeIntent;
    private tokenOverlapCount;
    private rankSkillMatches;
    private selectAutoSkill;
    private extractRequestedSkillSlugs;
    private resolveToolNameAndInput;
    private preflightToolInput;
    private parseHermesArgs;
    private extractHermesCall;
    private parseLooseObject;
    private extractToolCall;
    private buildToolCallSignature;
    private deriveToolRecoveryHint;
    private parseBooleanSetting;
    private parseNumberSetting;
    private parseFloatSetting;
    private parseEnabledSkillSlugs;
    private parseSkillBehavior;
    private loadRuntimeControls;
    private runLoop;
    stop(): void;
    getStatus(): AgentStatus;
    getHistory(): History;
}
//# sourceMappingURL=agent.d.ts.map