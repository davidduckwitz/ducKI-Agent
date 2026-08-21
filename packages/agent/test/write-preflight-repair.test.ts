import { describe, it, expect } from "vitest";
import { createAgentForParserTests } from "./utils/agent-test-harness";
import { filesystemTool } from "@ducki/tools";

/**
 * Regression coverage for the reported failure:
 *
 *   Guardrail: Abgebrochen: 10x in Folge ohne Erfolg
 *   failureReasons: ["filesystem:write requires string field 'content'"]
 *
 * The write was answerable every single time. Preflight and the tool simply disagreed about
 * what counts as "content", and a preflight rejection never reached the self-repair machinery,
 * so the model got the same complaint back ten times over.
 */
function makeAgent() {
  const agent = createAgentForParserTests();
  // The real tool, so preflight validates against the real schema (its property names are what
  // the mechanical field-name repair reconciles against).
  (agent as any).executor.registerTool(filesystemTool);
  return agent;
}

const controls = { enabledOptionalTools: [] as string[] };

const preflight = (agent: ReturnType<typeof makeAgent>, input: Record<string, unknown>) =>
  (agent as any).preflightToolInput("filesystem", input, controls) as Promise<{
    ok: boolean;
    input?: Record<string, unknown>;
    error?: string;
  }>;

describe("write preflight accepts what the tool accepts", () => {
  it("passes a body sent as file_text and normalises it onto content", async () => {
    const agent = makeAgent();
    const result = await preflight(agent, { action: "write", path: "docs/data-model.md", file_text: "# Modell" });

    expect(result.ok).toBe(true);
    expect(result.input?.["content"]).toBe("# Modell");
  });

  it("passes a body sent as text, contents or body", async () => {
    const agent = makeAgent();
    for (const field of ["text", "contents", "body"]) {
      const result = await preflight(agent, { action: "write", path: "a.md", [field]: "x" });
      expect(result.ok, field).toBe(true);
      expect(result.input?.["content"], field).toBe("x");
    }
  });

  it("accepts an array of lines", async () => {
    const agent = makeAgent();
    const result = await preflight(agent, { action: "write", path: "a.md", content: ["eins", "zwei"] });

    expect(result.ok).toBe(true);
    expect(result.input?.["content"]).toBe("eins\nzwei");
  });

  it("accepts an empty file body", async () => {
    const agent = makeAgent();
    const result = await preflight(agent, { action: "write", path: "empty.txt", content: "" });
    expect(result.ok).toBe(true);
  });

  it("applies the same rule to append", async () => {
    const agent = makeAgent();
    const result = await preflight(agent, { action: "append", path: "a.md", file_text: "mehr" });
    expect(result.ok).toBe(true);
    expect(result.input?.["content"]).toBe("mehr");
  });

  it("still rejects a write with no body at all, and says what to do", async () => {
    const agent = makeAgent();
    const result = await preflight(agent, { action: "write", path: "a.md" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("SAME call");
  });
});

describe("mechanical repair of field names", () => {
  const repair = (agent: ReturnType<typeof makeAgent>, input: Record<string, unknown>) =>
    (agent as any).deriveMechanicalRepair("filesystem", input) as
      | { toolName: string; input: Record<string, unknown> }
      | undefined;

  it("reconciles snake_case onto the schema's camelCase", async () => {
    const agent = makeAgent();
    const fixed = repair(agent, { action: "edit", path: "a.ts", old_string: "a", new_string: "b" });

    expect(fixed?.input["oldString"]).toBe("a");
    expect(fixed?.input["newString"]).toBe("b");
    expect(fixed?.input).not.toHaveProperty("old_string");
  });

  it("maps a semantic alias for path", async () => {
    const agent = makeAgent();
    const fixed = repair(agent, { action: "read", file_path: "src/app.ts" });

    expect(fixed?.input["path"]).toBe("src/app.ts");
    expect(fixed?.input).not.toHaveProperty("file_path");
  });

  it("never overwrites a value already given under the correct name", async () => {
    const agent = makeAgent();
    const fixed = repair(agent, { action: "read", path: "richtig.ts", file_path: "falsch.ts" });

    // Nothing to rename onto an occupied field - the enum pass finds nothing either.
    expect(fixed?.input["path"] ?? "richtig.ts").toBe("richtig.ts");
  });

  it("still fixes a near-miss enum value", async () => {
    const agent = makeAgent();
    const fixed = repair(agent, { action: "wirte", path: "a.txt", content: "x" });
    expect(fixed?.input["action"]).toBe("write");
  });

  it("fixes a renamed field and a misspelled action together", async () => {
    const agent = makeAgent();
    const fixed = repair(agent, { action: "raed", file_path: "a.txt" });
    expect(fixed?.input["action"]).toBe("read");
    expect(fixed?.input["path"]).toBe("a.txt");
  });

  it("leaves a well-formed call alone", async () => {
    const agent = makeAgent();
    expect(repair(agent, { action: "read", path: "a.txt" })).toBeUndefined();
  });
});
