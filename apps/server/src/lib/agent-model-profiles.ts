import type { DatabaseService } from "@ducki/database";

export type AgentModelProfileName = "legacy" | "small" | "balanced" | "large";

export interface AgentModelProfileDefinition {
  id: AgentModelProfileName;
  label: string;
  modelHint: string;
  description: string;
  settings: Readonly<Record<string, string>>;
}

/**
 * Settings that a model-size/tuning profile must NEVER change.
 *
 * Profiles are deliberately capability-neutral. They may tune how long an agent reasons,
 * whether generic quality passes are worthwhile, and how aggressively loops are stopped, but
 * they must not remove or add capabilities. This protects the main agent, custom bots, vision,
 * plugin tools, skill auto-detection and cross-agent/connector transfers from an innocent-looking
 * "use the small model profile" action in the Settings UI.
 */
export const MODEL_PROFILE_PROTECTED_KEYS = new Set([
  // Vision / media capability
  "AGENT_ENABLE_VISION",

  // Skill discovery / loading capability
  "AGENT_AUTO_SKILL_SELECTION",
  "AGENT_SKILL_BEHAVIOR",
  "AGENT_AUTO_SKILL_FALLBACK_NONE",
  "AGENT_AUTO_SKILL_THRESHOLD",
  "AGENT_AUTO_SKILL_MARGIN",
  "AGENT_AUTO_SKILL_MIN_INPUT_LEN",
  "AGENT_AUTO_SKILL_MIN_OVERLAP",
  "AGENT_ENABLED_SKILL_ALLOWLIST",
  "AGENT_ALWAYS_LOAD_SKILLS",

  // Optional/core tool capability. Plugin tools are intentionally not represented by profile
  // settings at all, but this protects the generic optional-tool gate too.
  "AGENT_ENABLED_OPTIONAL_TOOLS",
  "PLUGIN_CREATION_ENABLED",

  // Coding-area capability itself (budgets may change, whether it exists may not).
  "CODING_ENABLED",

  // Bot / multi-agent membership and capability policy.
  "BOT_TOOL_WHITELIST",
  "BOT_SKILL_WHITELIST",
  "BOT_CHAT_ENABLED",

  // Connector / worker / handoff capability switches. Prefix checks below also protect future
  // keys in these families without having to remember to extend this list.
  "MESSAGING_GATEWAYS",
]);

const PROTECTED_PREFIXES = [
  "PLUGIN_",
  "CONNECTOR_",
  "GATEWAY_",
  "HANDOFF_",
  "WORKER_",
  "BOT_TOOL_",
  "BOT_SKILL_",
];

/** True when a key controls capability/routing rather than model tuning. Exported for tests. */
export function isModelProfileProtectedKey(key: string): boolean {
  return MODEL_PROFILE_PROTECTED_KEYS.has(key) || PROTECTED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Current pre-profile behaviour, materialised explicitly. These values match the effective
 * defaults in Agent.loadRuntimeControls() and the CodingAgent settings UI/routes, not an older
 * .env example. Applying Legacy therefore means "behave like DucKI did before profiles".
 */
const LEGACY_SETTINGS: Readonly<Record<string, string>> = {
  AGENT_MAX_ITERATIONS: "50",
  AGENT_LIGHTWEIGHT_MAX_ITERATIONS: "10",
  AGENT_CHATBOT_MAX_ITERATIONS: "5",
  AGENT_MAX_OUTPUT_TOKENS: "16384",
  AGENT_TIMEOUT_MS: "600000",

  AGENT_ENABLE_REFLECTION: "true",
  AGENT_REFLECTION_MAX_RETRIES: "1",
  AGENT_REFLECTION_STORE_MEMORY: "false",
  AGENT_REFLECTION_META_REVIEW: "false",
  AGENT_REFLECTION_POST_ITERATION: "true",

  AGENT_CODING_MAX_ITERATIONS: "60",
  AGENT_CODING_ENABLE_REFLECTION: "false",
  AGENT_CODING_ENABLE_VERIFY: "false",

  AGENT_CHECKLIST_ENABLED: "false",
  AGENT_CHECKLIST_MIN_COMPLEXITY: "medium",
  AGENT_CHECKLIST_MAX_ITEM_ATTEMPTS: "3",
  AGENT_CHECKLIST_SKIPPED_POLICY: "soft",
  AGENT_RUN_JOURNAL_ENABLED: "true",

  AGENT_REASONER_USE_TOOL_MIN_CONFIDENCE: "0.65",
  AGENT_MAX_TOOL_FAILURES: "3",
  AGENT_MAX_REPEATED_TOOL_CALL: "3",
  AGENT_STALE_READ_STREAK: "4",
  AGENT_SELF_REPAIR: "true",
  AGENT_SELF_REPAIR_MAX_ATTEMPTS: "2",

  // Direct CodingAgent / plan execution budgets (separate controller from the main Agent).
  CODING_AGENT_MAX_ITERATIONS: "100",
  CODING_AGENT_MAX_ITERATIONS_SIMPLE: "20",
  CODING_AGENT_MAX_ITERATIONS_MEDIUM: "50",
  CODING_AGENT_MAX_ITERATIONS_COMPLEX: "100",
  CODING_AGENT_MAX_ATTEMPTS: "3",
  CODING_AGENT_TIMEOUT_MS: "300000",
};

const SMALL_SETTINGS: Readonly<Record<string, string>> = {
  AGENT_MAX_ITERATIONS: "18",
  AGENT_LIGHTWEIGHT_MAX_ITERATIONS: "8",
  AGENT_CHATBOT_MAX_ITERATIONS: "5",
  AGENT_MAX_OUTPUT_TOKENS: "6144",
  AGENT_TIMEOUT_MS: "480000",

  // Small models gain more from deterministic tool feedback than generic same-model critique.
  AGENT_ENABLE_REFLECTION: "false",
  AGENT_REFLECTION_MAX_RETRIES: "0",
  AGENT_REFLECTION_STORE_MEMORY: "false",
  AGENT_REFLECTION_META_REVIEW: "false",
  AGENT_REFLECTION_POST_ITERATION: "false",

  AGENT_CODING_MAX_ITERATIONS: "26",
  AGENT_CODING_ENABLE_REFLECTION: "false",
  AGENT_CODING_ENABLE_VERIFY: "true",

  AGENT_CHECKLIST_ENABLED: "true",
  AGENT_CHECKLIST_MIN_COMPLEXITY: "medium",
  AGENT_CHECKLIST_MAX_ITEM_ATTEMPTS: "2",
  AGENT_CHECKLIST_SKIPPED_POLICY: "soft",
  AGENT_RUN_JOURNAL_ENABLED: "true",

  AGENT_REASONER_USE_TOOL_MIN_CONFIDENCE: "0.65",
  AGENT_MAX_TOOL_FAILURES: "3",
  AGENT_MAX_REPEATED_TOOL_CALL: "2",
  AGENT_STALE_READ_STREAK: "3",
  AGENT_SELF_REPAIR: "true",
  AGENT_SELF_REPAIR_MAX_ATTEMPTS: "2",

  CODING_AGENT_MAX_ITERATIONS: "24",
  CODING_AGENT_MAX_ITERATIONS_SIMPLE: "18",
  CODING_AGENT_MAX_ITERATIONS_MEDIUM: "24",
  CODING_AGENT_MAX_ITERATIONS_COMPLEX: "32",
  CODING_AGENT_MAX_ATTEMPTS: "2",
  CODING_AGENT_TIMEOUT_MS: "480000",
};

const BALANCED_SETTINGS: Readonly<Record<string, string>> = {
  AGENT_MAX_ITERATIONS: "30",
  AGENT_LIGHTWEIGHT_MAX_ITERATIONS: "10",
  AGENT_CHATBOT_MAX_ITERATIONS: "5",
  AGENT_MAX_OUTPUT_TOKENS: "8192",
  AGENT_TIMEOUT_MS: "540000",

  AGENT_ENABLE_REFLECTION: "false",
  AGENT_REFLECTION_MAX_RETRIES: "1",
  AGENT_REFLECTION_STORE_MEMORY: "false",
  AGENT_REFLECTION_META_REVIEW: "false",
  AGENT_REFLECTION_POST_ITERATION: "false",

  AGENT_CODING_MAX_ITERATIONS: "36",
  AGENT_CODING_ENABLE_REFLECTION: "false",
  AGENT_CODING_ENABLE_VERIFY: "true",

  AGENT_CHECKLIST_ENABLED: "true",
  AGENT_CHECKLIST_MIN_COMPLEXITY: "medium",
  AGENT_CHECKLIST_MAX_ITEM_ATTEMPTS: "2",
  AGENT_CHECKLIST_SKIPPED_POLICY: "soft",
  AGENT_RUN_JOURNAL_ENABLED: "true",

  AGENT_REASONER_USE_TOOL_MIN_CONFIDENCE: "0.68",
  AGENT_MAX_TOOL_FAILURES: "3",
  AGENT_MAX_REPEATED_TOOL_CALL: "2",
  AGENT_STALE_READ_STREAK: "3",
  AGENT_SELF_REPAIR: "true",
  AGENT_SELF_REPAIR_MAX_ATTEMPTS: "2",

  CODING_AGENT_MAX_ITERATIONS: "36",
  CODING_AGENT_MAX_ITERATIONS_SIMPLE: "24",
  CODING_AGENT_MAX_ITERATIONS_MEDIUM: "36",
  CODING_AGENT_MAX_ITERATIONS_COMPLEX: "48",
  CODING_AGENT_MAX_ATTEMPTS: "3",
  CODING_AGENT_TIMEOUT_MS: "540000",
};

const LARGE_SETTINGS: Readonly<Record<string, string>> = {
  AGENT_MAX_ITERATIONS: "45",
  AGENT_LIGHTWEIGHT_MAX_ITERATIONS: "10",
  AGENT_CHATBOT_MAX_ITERATIONS: "5",
  AGENT_MAX_OUTPUT_TOKENS: "12288",
  AGENT_TIMEOUT_MS: "600000",

  AGENT_ENABLE_REFLECTION: "true",
  AGENT_REFLECTION_MAX_RETRIES: "1",
  AGENT_REFLECTION_STORE_MEMORY: "false",
  AGENT_REFLECTION_META_REVIEW: "false",
  AGENT_REFLECTION_POST_ITERATION: "false",

  AGENT_CODING_MAX_ITERATIONS: "45",
  AGENT_CODING_ENABLE_REFLECTION: "false",
  AGENT_CODING_ENABLE_VERIFY: "true",

  AGENT_CHECKLIST_ENABLED: "true",
  AGENT_CHECKLIST_MIN_COMPLEXITY: "medium",
  AGENT_CHECKLIST_MAX_ITEM_ATTEMPTS: "3",
  AGENT_CHECKLIST_SKIPPED_POLICY: "soft",
  AGENT_RUN_JOURNAL_ENABLED: "true",

  AGENT_REASONER_USE_TOOL_MIN_CONFIDENCE: "0.70",
  AGENT_MAX_TOOL_FAILURES: "3",
  AGENT_MAX_REPEATED_TOOL_CALL: "3",
  AGENT_STALE_READ_STREAK: "4",
  AGENT_SELF_REPAIR: "true",
  AGENT_SELF_REPAIR_MAX_ATTEMPTS: "3",

  CODING_AGENT_MAX_ITERATIONS: "50",
  CODING_AGENT_MAX_ITERATIONS_SIMPLE: "30",
  CODING_AGENT_MAX_ITERATIONS_MEDIUM: "50",
  CODING_AGENT_MAX_ITERATIONS_COMPLEX: "70",
  CODING_AGENT_MAX_ATTEMPTS: "3",
  CODING_AGENT_TIMEOUT_MS: "600000",
};

export const AGENT_MODEL_PROFILES: Readonly<Record<AgentModelProfileName, AgentModelProfileDefinition>> = {
  legacy: {
    id: "legacy",
    label: "Legacy / Kompatibel",
    modelHint: "Bisheriges DucKI-Verhalten",
    description: "Materialisiert die bisherigen Runtime-Defaults. Beste Wahl zum Vergleich oder Rollback.",
    settings: LEGACY_SETTINGS,
  },
  small: {
    id: "small",
    label: "Small",
    modelHint: "ca. 7B–14B",
    description: "Weniger Schleifen und freie Reflection, mehr strukturierter State und deterministische Coding-Verifikation.",
    settings: SMALL_SETTINGS,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    modelHint: "ca. 14B–32B",
    description: "Mittlere Budgets für lokale oder kostensensitive Modelle mit gutem Tool Calling.",
    settings: BALANCED_SETTINGS,
  },
  large: {
    id: "large",
    label: "Large",
    modelHint: "ca. 32B+ / starke APIs",
    description: "Groessere Budgets, ohne die besonders teuren post-iteration Reflection-Schleifen wieder global einzuschalten.",
    settings: LARGE_SETTINGS,
  },
};

export function parseAgentModelProfile(value: unknown): AgentModelProfileName | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "legacy" || normalized === "small" || normalized === "balanced" || normalized === "large"
    ? normalized
    : undefined;
}

export function assertProfileIsCapabilityNeutral(profile: AgentModelProfileDefinition): void {
  const protectedKeys = Object.keys(profile.settings).filter(isModelProfileProtectedKey);
  if (protectedKeys.length > 0) {
    throw new Error(`Model profile '${profile.id}' attempts to modify protected capability settings: ${protectedKeys.join(", ")}`);
  }
}

/** Apply one profile to persisted runtime settings. The settings DB is what Agent reads per run. */
export async function applyAgentModelProfile(
  db: DatabaseService,
  profileName: AgentModelProfileName
): Promise<{ profile: AgentModelProfileName; appliedKeys: string[] }> {
  const profile = AGENT_MODEL_PROFILES[profileName];
  assertProfileIsCapabilityNeutral(profile);

  const entries = Object.entries(profile.settings);
  for (const [key, value] of entries) {
    await db.setSetting(key, value);
  }

  return { profile: profileName, appliedKeys: entries.map(([key]) => key) };
}

/**
 * Best-effort UI indicator. An untouched installation is Legacy; once managed values exist, a
 * profile is reported only when every managed value matches exactly. Manual fine-tuning is shown
 * as `custom` rather than pretending a named preset is still active.
 */
export function inferAgentModelProfile(settings: ReadonlyMap<string, string>): AgentModelProfileName | "custom" {
  const managedKeys = new Set(Object.values(AGENT_MODEL_PROFILES).flatMap((profile) => Object.keys(profile.settings)));
  const hasManagedSetting = [...managedKeys].some((key) => settings.has(key));
  if (!hasManagedSetting) return "legacy";

  for (const profile of Object.values(AGENT_MODEL_PROFILES)) {
    const matches = Object.entries(profile.settings).every(([key, value]) => settings.get(key) === value);
    if (matches) return profile.id;
  }
  return "custom";
}
