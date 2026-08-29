import {
  Cpu,
  KeyRound,
  RefreshCw,
  Mic,
  MessageSquare,
  Terminal,
  Gauge,
  Clock,
  Wrench,
  Sparkles,
  Target,
  ListChecks,
  ScrollText,
  Database,
  BookOpen,
  HardDrive,
  CreditCard,
  Monitor,
  type LucideIcon,
} from "lucide-react";

export interface ProviderMeta {
  id: string;
  label: string;
  emoji: string;
  description: string;
  color: "blue" | "green" | "purple" | "amber";
}

// One box per LLM provider - all its fields (base url, model, api key) are
// pulled together here even though they live in different PREDEFINED_FIELDS
// sections, so the user configures a provider end-to-end in one place.
export const PROVIDER_META: ProviderMeta[] = [
  {
    id: "lmstudio",
    label: "LM Studio",
    emoji: "🖥️",
    description: "Lokales, kostenloses LLM über den LM Studio Server",
    color: "blue",
  },
  {
    id: "openai",
    label: "OpenAI",
    emoji: "🤖",
    description: "GPT-4o und weitere Modelle über die offizielle OpenAI API",
    color: "green",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    emoji: "🌐",
    description: "Zugriff auf viele Modelle verschiedener Anbieter über eine API",
    color: "purple",
  },
  {
    id: "ollama",
    label: "Ollama",
    emoji: "🦙",
    description: "Lokal gehostete Open-Source-Modelle über Ollama",
    color: "amber",
  },
  {
    id: "claude",
    label: "Claude (Anthropic)",
    emoji: "🧠",
    description: "Claude 3.5 Sonnet und andere Modelle via Anthropic API",
    color: "purple",
  },
];

export const PROVIDER_FIELD_MAP: Record<string, string> = {
  OPENAI_MODEL: "openai",
  OPENAI_API_KEY: "openai",
  OPENROUTER_MODEL: "openrouter",
  OPENROUTER_API_KEY: "openrouter",
  LM_STUDIO_BASE_URL: "lmstudio",
  LM_STUDIO_MODEL: "lmstudio",
  LM_STUDIO_API_KEY: "lmstudio",
  OLLAMA_BASE_URL: "ollama",
  OLLAMA_MODEL: "ollama",
  CLAUDE_MODEL: "claude",
  CLAUDE_API_KEY: "claude",
};

export const PROVIDER_BORDER_CLASS: Record<ProviderMeta["color"], string> = {
  blue: "border-blue-500",
  green: "border-green-500",
  purple: "border-purple-500",
  amber: "border-amber-500",
};

export interface SubsectionGroup {
  name: string;
  icon: LucideIcon;
  keys: string[];
}

// Groups the flat field list of each non-Provider tab into named boxes so
// related settings (e.g. all Auto-Update fields) render together.
export const SUBSECTIONS: Record<string, SubsectionGroup[]> = {
  API: [
    {
      name: "Auto-Update",
      icon: RefreshCw,
      keys: [
        "AUTO_UPDATE_ENABLED",
        "AUTO_UPDATE_REPO_URL",
        "AUTO_UPDATE_BRANCH",
        "AUTO_UPDATE_INTERVAL_MIN",
        "AUTO_UPDATE_REQUIRE_CLEAN_WORKTREE",
        "AUTO_UPDATE_WORKDIR",
      ],
    },
  ],
  Speech: [
    {
      name: "Standard-Transkription (nodejs-whisper)",
      icon: Mic,
      keys: [
        "DEFAULT_SPEECH_TO_TEXT_PROVIDER",
        "NODEJS_WHISPER_MODEL_NAME",
        "NODEJS_WHISPER_MODEL_ROOT_PATH",
        "NODEJS_WHISPER_AUTO_DOWNLOAD",
        "NODEJS_WHISPER_USE_CUDA",
        "NODEJS_WHISPER_LANGUAGE",
        "NODEJS_WHISPER_TIMEOUT_MS",
        "NODEJS_WHISPER_INPUT_EXT",
      ],
    },
    {
      name: "Discord Sprachnachrichten",
      icon: MessageSquare,
      keys: [
        "DISCORD_VOICE_STT_PROVIDER",
        "DISCORD_VOICE_STT_MODEL",
        "DISCORD_VOICE_STT_COMMAND",
        "DISCORD_VOICE_STT_ARGS",
        "DISCORD_VOICE_STT_TIMEOUT_MS",
      ],
    },
    {
      name: "Lokales STT-Kommando",
      icon: Terminal,
      keys: [
        "LOCAL_STT_COMMAND",
        "LOCAL_STT_ARGS",
        "LOCAL_STT_WORKDIR",
        "LOCAL_STT_TIMEOUT_MS",
        "LOCAL_STT_INPUT_EXT",
      ],
    },
  ],
  Agent: [
    {
      name: "Basis & Limits",
      icon: Gauge,
      keys: [
        "AGENT_MAX_ITERATIONS",
        "AGENT_LIGHTWEIGHT_MAX_ITERATIONS",
        "AGENT_CHATBOT_MAX_ITERATIONS",
        "AGENT_TIMEOUT_MS",
        "AGENT_MAX_TOOL_FAILURES",
        "AGENT_MAX_REPEATED_TOOL_CALL",
        "AGENT_STALE_READ_STREAK",
        "CODING_ENABLED",
        "PLUGIN_CREATION_ENABLED",
      ],
    },
    {
      name: "Tool-Timeouts",
      icon: Clock,
      keys: [
        "AGENT_TOOL_TIMEOUT_SHELL_MS",
        "AGENT_TOOL_TIMEOUT_HTTP_MS",
        "AGENT_TOOL_TIMEOUT_BROWSER_MS",
        "AGENT_TOOL_TIMEOUT_GIT_MS",
      ],
    },
    {
      name: "Self-Repair & Reflection",
      icon: Wrench,
      keys: [
        "AGENT_SELF_REPAIR",
        "AGENT_SELF_REPAIR_MAX_ATTEMPTS",
        "AGENT_ENABLE_REFLECTION",
        "AGENT_REFLECTION_MAX_RETRIES",
        "AGENT_REFLECTION_STORE_MEMORY",
        "AGENT_REFLECTION_META_REVIEW",
        "AGENT_QUALITY_PASS_TIMEOUT_MS",
        "AGENT_AUTO_MEMORY",
      ],
    },
    {
      name: "Verifikation (Critic)",
      icon: Target,
      keys: [
        "AGENT_ENABLE_VERIFY",
        "AGENT_VERIFY_MAX_FIX_ATTEMPTS",
        "AGENT_VERIFY_DERIVE_CONSTRAINTS",
      ],
    },
    {
      name: "Session-Checkliste",
      icon: ListChecks,
      keys: [
        "AGENT_CHECKLIST_ENABLED",
        "AGENT_CHECKLIST_MIN_COMPLEXITY",
        "AGENT_CHECKLIST_MAX_ITEM_ATTEMPTS",
        "AGENT_CHECKLIST_SKIPPED_POLICY",
      ],
    },
    {
      name: "Run-Journal",
      icon: ScrollText,
      keys: [
        "AGENT_RUN_JOURNAL_ENABLED",
      ],
    },
    {
      name: "Kosten-Governor",
      icon: Gauge,
      keys: [
        "AGENT_COST_BUDGET_USD",
        "AGENT_COST_GOVERNOR_STOP",
      ],
    },
    {
      name: "Vision (Observer)",
      icon: Monitor,
      keys: [
        "AGENT_ENABLE_VISION",
      ],
    },
    {
      name: "Skill-Auswahl",
      icon: Sparkles,
      keys: [
        "AGENT_AUTO_SKILL_SELECTION",
        "AGENT_SKILL_BEHAVIOR",
        "AGENT_AUTO_SKILL_FALLBACK_NONE",
        "AGENT_AUTO_SKILL_THRESHOLD",
        "AGENT_AUTO_SKILL_MARGIN",
        "AGENT_AUTO_SKILL_MIN_INPUT_LEN",
        "AGENT_AUTO_SKILL_MIN_OVERLAP",
      ],
    },
    {
      name: "Plan-Modus",
      icon: Target,
      keys: [
        "PLAN_MODE_ENABLED",
        "PLAN_MODE_AUTO_SAVE",
        "PLAN_MODE_AUTO_EXECUTE",
        "PLAN_MODE_MARKDOWN_PATH",
      ],
    },
    {
      name: "Umsetzungs-Modus",
      icon: Target,
      keys: [
        "EXECUTION_MODE_AUTO_CREATE_PROJECT",
        "EXECUTION_MODE_VALIDATION_INTERVAL",
        "EXECUTION_MODE_MAX_RETRIES",
        "EXECUTION_MODE_TIMEOUT_MINUTES",
        "EXECUTION_MODE_UPDATE_PLAN_FILE",
      ],
    },
    {
      name: "Coding Agent",
      icon: Terminal,
      keys: [
        "CODING_AGENT_MAX_ITERATIONS",
        "CODING_AGENT_MAX_ITERATIONS_SIMPLE",
        "CODING_AGENT_MAX_ITERATIONS_MEDIUM",
        "CODING_AGENT_MAX_ITERATIONS_COMPLEX",
        "CODING_AGENT_MAX_ATTEMPTS",
        "CODING_AGENT_TIMEOUT_MS",
        "CODING_AGENT_EXPLORE_TIMEOUT_MS",
      ],
    },
    {
      name: "Tool-Calling",
      icon: Wrench,
      keys: ["AGENT_NATIVE_TOOLS_ENABLED"],
    },
    {
      name: "Coding-Laeufe (Chat & Plan)",
      icon: Terminal,
      keys: [
        "AGENT_CODING_MAX_ITERATIONS",
        "AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES",
        "AGENT_CODING_ENABLE_REFLECTION",
        "AGENT_CODING_ENABLE_VERIFY",
      ],
    },
    {
      name: "Datei-Limits (Standard-Agent)",
      icon: HardDrive,
      keys: [
        "AGENT_MAX_TOOL_RESULT_CHARS",
        "AGENT_MAX_TOOL_FIELD_CHARS",
        "AGENT_TOOL_RESULT_PREVIEW_CHARS",
        "AGENT_MAX_CONTEXT_CHARS",
        "AGENT_FS_READ_DEFAULT_LINES",
        "AGENT_FS_READ_MAX_BYTES",
        "AGENT_FS_READ_MAX_LINE_CHARS",
        "AGENT_FS_GLOB_MAX_RESULTS",
        "AGENT_FS_GREP_MAX_RESULTS",
      ],
    },
    {
      name: "Datei-Limits (Coding Agent)",
      icon: HardDrive,
      keys: [
        "AGENT_CODING_MAX_TOOL_RESULT_CHARS",
        "AGENT_CODING_MAX_TOOL_FIELD_CHARS",
        "AGENT_CODING_MAX_CONTEXT_CHARS",
        "AGENT_CODING_FS_READ_DEFAULT_LINES",
        "AGENT_CODING_FS_READ_MAX_BYTES",
      ],
    },
  ],
  Memory: [
    {
      name: "Memory-Limits",
      icon: Target,
      keys: [
        "MEMORY_AUTO_APPROVE",
        "MEMORY_SHORT_TERM_LIMIT",
        "MEMORY_IMPORTANCE_THRESHOLD",
        "AGENT_MEMORY_CHAR_LIMIT",
        "USER_MEMORY_CHAR_LIMIT",
      ],
    },
    {
      name: "LLM-Wiki",
      icon: BookOpen,
      keys: [
        "WIKI_ENABLED",
        "WIKI_SHARED_SOURCE_PATH",
        "WIKI_SHARED_SOURCE_AUTO_MEMORY",
        "WIKI_AUTO_APPROVE",
        "WIKI_SHARED_SOURCE_MAX_FILE_SIZE_KB",
        "WIKI_INGEST_INTERVAL_MS",
        "WIKI_CHUNK_SIZE_CHARS",
        "WIKI_CHUNK_OVERLAP_CHARS",
      ],
    },
  ],
  Browser: [
    {
      name: "Display & Viewport",
      icon: Monitor,
      keys: [
        "BROWSER_HEADLESS_MODE",
        "BROWSER_REUSE_SESSION",
        "BROWSER_VIEWPORT_WIDTH",
        "BROWSER_VIEWPORT_HEIGHT",
        "BROWSER_CUSTOM_EXECUTABLE_PATH",
        "BROWSER_USER_AGENT",
      ],
    },
    {
      name: "Screenshot Settings",
      icon: Target,
      keys: [
        "BROWSER_SCREENSHOT_FORMAT",
        "BROWSER_SCREENSHOT_QUALITY",
      ],
    },
    {
      name: "Performance & Detection",
      icon: Gauge,
      keys: [
        "BROWSER_DISABLE_IMAGES",
        "BROWSER_BLOCK_RESOURCES",
        "BROWSER_DISABLE_AUTOMATION",
        "BROWSER_COOKIE_DETECTION",
        "BROWSER_PROXY_URL",
      ],
    },
  ],
};

export const TAB_ICONS: Record<string, LucideIcon> = {
  Provider: Cpu,
  API: KeyRound,
  Speech: Mic,
  Voice: Mic,
  Agent: Sparkles,
  Memory: BookOpen,
  Database: HardDrive,
  Browser: Monitor,
  Crypto: CreditCard,
};
