import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";

/**
 * Regression coverage for a false-positive in the "announced but unexecuted action"
 * guardrail (detectForwardIntentClaim): "ausführen" is genuinely ambiguous in German -
 * "ich werde das ausführen" (I will execute it) vs. "soll ich das näher ausführen?"
 * (should I elaborate on that?) - an entirely ordinary way to end a normal conversational
 * answer. The guardrail used to treat the latter as an unexecuted work promise and force
 * a retry, silently discarding a perfectly good answer (observed with a real chat reply
 * about stored CHS/wiki knowledge that ended in "...ausführe?").
 */
function stubDb() {
  const known: Record<string, (...args: unknown[]) => unknown> = {
    getSetting: async () => undefined,
    getAllSettings: async () => [],
    getEverUsedSkills: async () => [],
  };
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target];
      return async () => undefined;
    },
  }) as never;
}

function detectForwardIntentClaim(response: string): boolean {
  const agent = new Agent({} as never, stubDb());
  return (agent as unknown as { detectForwardIntentClaim(r: string): boolean }).detectForwardIntentClaim(response);
}

describe("detectForwardIntentClaim - German 'ausführen' ambiguity", () => {
  it("does not flag a normal answer offering to elaborate on a document", () => {
    const response = [
      "Ich habe detaillierte Informationen über CHS (Cannabinoid Hyperemesis Syndrome) in meinem Wissenssystem gespeichert.",
      "Die gespeicherten Informationen umfassen:",
      "- CHS_review.md - Eine umfassende Review-Studie",
      "- CHS_review_addendum.md - Ergänzende Informationen",
      "Möchtest du, dass ich die Details aus einem dieser Dokumente ausführe?",
    ].join("\n");
    expect(detectForwardIntentClaim(response)).toBe(false);
  });

  it("still catches a genuine unexecuted work promise using 'durchführen'/'fuehre aus'", () => {
    const response = "Ich werde jetzt die Migration durchführen.";
    expect(detectForwardIntentClaim(response)).toBe(true);
  });

  it("still catches an unexecuted file-edit promise unrelated to 'ausführen'", () => {
    const response = "Ich werde jetzt die Datei config.json bearbeiten.";
    expect(detectForwardIntentClaim(response)).toBe(true);
  });
});
