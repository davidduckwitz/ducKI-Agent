import { describe, expect, it, vi } from "vitest";
import {
  AGENT_MODEL_PROFILES,
  MODEL_PROFILE_PROTECTED_KEYS,
  applyAgentModelProfile,
  assertProfileIsCapabilityNeutral,
  inferAgentModelProfile,
  isModelProfileProtectedKey,
  parseAgentModelProfile,
} from "./agent-model-profiles.js";

describe("agent model profiles", () => {
  it("accepts only named profiles", () => {
    expect(parseAgentModelProfile("small")).toBe("small");
    expect(parseAgentModelProfile(" BALANCED ")).toBe("balanced");
    expect(parseAgentModelProfile("huge")).toBeUndefined();
    expect(parseAgentModelProfile(undefined)).toBeUndefined();
  });

  it("legacy matches the effective pre-profile runtime and direct CodingAgent defaults", () => {
    expect(AGENT_MODEL_PROFILES.legacy.settings).toMatchObject({
      AGENT_MAX_ITERATIONS: "50",
      AGENT_MAX_OUTPUT_TOKENS: "16384",
      AGENT_TIMEOUT_MS: "600000",
      AGENT_ENABLE_REFLECTION: "true",
      AGENT_REFLECTION_MAX_RETRIES: "1",
      AGENT_REFLECTION_STORE_MEMORY: "false",
      AGENT_REFLECTION_META_REVIEW: "false",
      AGENT_REFLECTION_POST_ITERATION: "true",
      AGENT_CHECKLIST_ENABLED: "false",
      AGENT_RUN_JOURNAL_ENABLED: "true",
      AGENT_REASONER_USE_TOOL_MIN_CONFIDENCE: "0.65",
      AGENT_MAX_REPEATED_TOOL_CALL: "3",
      AGENT_STALE_READ_STREAK: "4",
      AGENT_SELF_REPAIR_MAX_ATTEMPTS: "2",
      CODING_AGENT_MAX_ITERATIONS_SIMPLE: "20",
      CODING_AGENT_MAX_ITERATIONS_MEDIUM: "50",
      CODING_AGENT_MAX_ITERATIONS_COMPLEX: "100",
      CODING_AGENT_MAX_ATTEMPTS: "3",
      CODING_AGENT_TIMEOUT_MS: "300000",
    });
  });

  it("never changes capability, routing, plugin, skill, vision, bot or worker settings", () => {
    const forbiddenExamples = [
      "AGENT_ENABLE_VISION",
      "AGENT_AUTO_SKILL_SELECTION",
      "AGENT_SKILL_BEHAVIOR",
      "AGENT_ENABLED_SKILL_ALLOWLIST",
      "AGENT_ENABLED_OPTIONAL_TOOLS",
      "CODING_ENABLED",
      "PLUGIN_CREATION_ENABLED",
      "PLUGIN_SOMETHING_FUTURE",
      "CONNECTOR_DISCORD_ENABLED",
      "GATEWAY_ENABLED",
      "HANDOFF_ENABLED",
      "WORKER_TRANSFER_ENABLED",
      "BOT_TOOL_WHITELIST",
      "BOT_SKILL_WHITELIST",
    ];

    for (const key of forbiddenExamples) expect(isModelProfileProtectedKey(key)).toBe(true);
    expect(MODEL_PROFILE_PROTECTED_KEYS.has("AGENT_ENABLE_VISION")).toBe(true);

    for (const profile of Object.values(AGENT_MODEL_PROFILES)) {
      expect(() => assertProfileIsCapabilityNeutral(profile)).not.toThrow();
      for (const key of Object.keys(profile.settings)) {
        expect(isModelProfileProtectedKey(key), `${profile.id} must not manage ${key}`).toBe(false);
      }
    }
  });

  it("fails closed if a future profile accidentally contains a protected setting", () => {
    expect(() =>
      assertProfileIsCapabilityNeutral({
        id: "small",
        label: "bad",
        modelHint: "test",
        description: "test",
        settings: { AGENT_ENABLE_VISION: "false" },
      })
    ).toThrow(/protected capability settings/i);
  });

  it("applies only the selected tuning settings", async () => {
    const setSetting = vi.fn().mockResolvedValue(undefined);
    const db = { setSetting } as any;

    const result = await applyAgentModelProfile(db, "small");

    expect(result.profile).toBe("small");
    expect(result.appliedKeys.length).toBe(Object.keys(AGENT_MODEL_PROFILES.small.settings).length);
    expect(setSetting).toHaveBeenCalledWith("AGENT_MAX_ITERATIONS", "18");
    expect(setSetting).toHaveBeenCalledWith("AGENT_CODING_ENABLE_VERIFY", "true");
    expect(setSetting).not.toHaveBeenCalledWith("AGENT_ENABLE_VISION", expect.anything());
    expect(setSetting).not.toHaveBeenCalledWith("AGENT_AUTO_SKILL_SELECTION", expect.anything());
  });

  it("infers legacy for untouched installs and custom after a manual override", () => {
    expect(inferAgentModelProfile(new Map())).toBe("legacy");

    const exactSmall = new Map(Object.entries(AGENT_MODEL_PROFILES.small.settings));
    expect(inferAgentModelProfile(exactSmall)).toBe("small");

    exactSmall.set("AGENT_MAX_ITERATIONS", "19");
    expect(inferAgentModelProfile(exactSmall)).toBe("custom");
  });
});
