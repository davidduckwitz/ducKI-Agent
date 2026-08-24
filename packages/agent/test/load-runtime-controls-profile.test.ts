import { afterEach, describe, expect, it } from "vitest";
import { getAgentModelProfile, loadAgentRuntimeControls } from "../src/config/load-runtime-controls";

const KEYS = [
  "AGENT_MODEL_PROFILE",
  "AGENT_MAX_ITERATIONS",
  "AGENT_MAX_OUTPUT_TOKENS",
  "AGENT_TIMEOUT_MS",
  "AGENT_ENABLE_REFLECTION",
  "AGENT_REFLECTION_MAX_RETRIES",
  "AGENT_REFLECTION_STORE_MEMORY",
  "AGENT_REFLECTION_META_REVIEW",
  "AGENT_REFLECTION_POST_ITERATION",
  "AGENT_CODING_MAX_ITERATIONS",
  "AGENT_CODING_ENABLE_REFLECTION",
  "AGENT_CODING_ENABLE_VERIFY",
  "AGENT_CHECKLIST_ENABLED",
  "AGENT_CHECKLIST_MAX_ITEM_ATTEMPTS",
  "AGENT_REASONER_MIN_CONFIDENCE",
  "AGENT_MAX_REPEATED_TOOL_CALL",
  "AGENT_STALE_READ_STREAK",
  "AGENT_SELF_REPAIR_MAX_ATTEMPTS",
] as const;

const original = new Map(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("agent model profiles", () => {
  it("falls back to legacy for missing or unknown profiles", () => {
    expect(getAgentModelProfile(undefined)).toBe("legacy");
    expect(getAgentModelProfile("unknown")).toBe("legacy");
  });

  it("applies small-model defaults without free-form reflection loops", () => {
    for (const key of KEYS) delete process.env[key];
    process.env["AGENT_MODEL_PROFILE"] = "small";

    const controls = loadAgentRuntimeControls();

    expect(controls.maxIterations).toBe(18);
    expect(controls.maxOutputTokens).toBe(6144);
    expect(controls.timeoutMs).toBe(480000);
    expect(controls.enableReflection).toBe(false);
    expect(controls.reflectionMaxRetries).toBe(0);
    expect(controls.reflectionStoreMemory).toBe(false);
    expect(controls.reflectionMetaReview).toBe(false);
    expect(controls.reflectionPostIteration).toBe(false);
    expect(controls.codingMaxIterations).toBe(26);
    expect(controls.codingEnableReflection).toBe(false);
    expect(controls.codingEnableVerify).toBe(true);
    expect(controls.checklistEnabled).toBe(true);
    expect(controls.checklistMaxItemAttempts).toBe(2);
    expect(controls.reasonerUseToolMinConfidence).toBe(0.65);
    expect(controls.maxRepeatedToolCall).toBe(2);
    expect(controls.staleReadLoopThreshold).toBe(3);
    expect(controls.selfRepairMaxAttempts).toBe(2);
  });

  it("keeps explicit environment settings authoritative over a profile", () => {
    for (const key of KEYS) delete process.env[key];
    process.env["AGENT_MODEL_PROFILE"] = "small";
    process.env["AGENT_MAX_ITERATIONS"] = "31";
    process.env["AGENT_ENABLE_REFLECTION"] = "true";
    process.env["AGENT_CODING_ENABLE_VERIFY"] = "false";
    process.env["AGENT_CHECKLIST_ENABLED"] = "false";

    const controls = loadAgentRuntimeControls();

    expect(controls.maxIterations).toBe(31);
    expect(controls.enableReflection).toBe(true);
    expect(controls.codingEnableVerify).toBe(false);
    expect(controls.checklistEnabled).toBe(false);
  });

  it("preserves the old defaults when no profile is selected", () => {
    for (const key of KEYS) delete process.env[key];

    const controls = loadAgentRuntimeControls();

    expect(controls.maxIterations).toBe(50);
    expect(controls.maxOutputTokens).toBe(16384);
    expect(controls.enableReflection).toBe(true);
    expect(controls.reflectionMaxRetries).toBe(3);
    expect(controls.codingMaxIterations).toBe(60);
    expect(controls.codingEnableVerify).toBe(false);
    expect(controls.checklistEnabled).toBe(false);
  });
});
