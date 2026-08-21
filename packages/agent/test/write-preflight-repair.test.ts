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

  it("refuses an empty body, because it is almost always a truncated call", async () => {
    // Caught in preflight rather than at the tool so the failure is visible before anything is
    // written. Writing it would produce a 0-byte file and report success - see EMPTY_CONTENT_ERROR.
    const agent = makeAgent();
    const result = await preflight(agent, { action: "write", path: "empty.txt", content: "" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Refusing to write an empty file");
  });

  it("accepts an empty body when it is explicitly intended", async () => {
    const agent = makeAgent();
    const result = await preflight(agent, {
      action: "write",
      path: "placeholder.txt",
      content: "",
      allowEmpty: true,
    });

    expect(result.ok).toBe(true);
    expect(result.input?.["content"]).toBe("");
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

/**
 * Self-repair may fix the SHAPE of a call, never its payload.
 *
 * Both of these were observed as silent data loss: the repair pass "corrected" a write and the
 * user's file came out empty, while the model's own reasoning still showed the full document.
 */
describe("self-repair must not destroy the file body", () => {
  const sanitize = (
    agent: ReturnType<typeof makeAgent>,
    original: Record<string, unknown>,
    repaired: Record<string, unknown>
  ) => (agent as any).sanitizeRepairedInput("filesystem", original, repaired) as
    | Record<string, unknown>
    | undefined;

  const DOC = "<!DOCTYPE html>\n<html lang=\"de\">\n<head></head>\n<body>Inhalt</body>\n</html>";

  it("discards a repair that shortened the content", () => {
    const agent = makeAgent();
    const result = sanitize(
      agent,
      { action: "write", path: "index.html", content: DOC },
      { action: "write", path: "index.html", content: "<!DOCTYPE html>" }
    );
    expect(result).toBeUndefined();
  });

  it("discards a repair that dropped the content entirely", () => {
    const agent = makeAgent();
    const result = sanitize(
      agent,
      { action: "write", path: "index.html", content: DOC },
      { action: "write", path: "index.html" }
    );
    expect(result).toBeUndefined();
  });

  it("discards a repair that invented content where there was none", () => {
    const agent = makeAgent();
    const result = sanitize(
      agent,
      { action: "write", path: "index.html" },
      { action: "write", path: "index.html", content: "<h1>Erfunden</h1>" }
    );
    expect(result).toBeUndefined();
  });

  it("strips allowEmpty that the repair pass introduced", () => {
    // The empty-content error used to name this flag as the way out; the repair model read the
    // error and set it, turning a truncated write into a successful 0-byte file.
    const agent = makeAgent();
    const result = sanitize(
      agent,
      { action: "write", path: "index.html", content: "" },
      { action: "write", path: "index.html", content: "", allowEmpty: true }
    );
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty("allowEmpty");
  });

  it("keeps allowEmpty when the acting model asked for it itself", () => {
    const agent = makeAgent();
    const result = sanitize(
      agent,
      { action: "write", path: "a.txt", content: "", allowEmpty: true },
      { action: "write", path: "a.txt", content: "", allowEmpty: true }
    );
    expect(result?.["allowEmpty"]).toBe(true);
  });

  it("allows the useful repair of moving the body onto the canonical field", () => {
    const agent = makeAgent();
    const result = sanitize(
      agent,
      { action: "write", path: "index.html", file_text: DOC },
      { action: "write", path: "index.html", content: DOC }
    );
    expect(result?.["content"]).toBe(DOC);
  });

  it("allows a repair that only fixes the path", () => {
    const agent = makeAgent();
    const result = sanitize(
      agent,
      { action: "write", path: "/abs/index.html", content: DOC },
      { action: "write", path: "index.html", content: DOC }
    );
    expect(result?.["path"]).toBe("index.html");
    expect(result?.["content"]).toBe(DOC);
  });

  it("leaves non-filesystem tools alone", () => {
    const agent = makeAgent();
    const repaired = { command: "npm test" };
    expect((agent as any).sanitizeRepairedInput("shell", { command: "npm tset" }, repaired)).toBe(repaired);
  });
});

/**
 * A truncated response must not produce a truncated file.
 *
 * When the model exhausts its output budget mid-content, the JSON repair pass closes the
 * dangling string and hands over whatever arrived. Measured on a 30 KB document: a response cut
 * at 90% yielded 27075 of 30064 characters - written with success:true. The provider tells us
 * this happened via finish_reason "length".
 */
describe("callWouldPersistContent", () => {
  it("covers exactly the actions that persist a model-authored payload", async () => {
    const { callWouldPersistContent } = await import("../src/agent.ts");

    expect(callWouldPersistContent("filesystem", { action: "write" })).toBe(true);
    expect(callWouldPersistContent("filesystem", { action: "append" })).toBe(true);

    // Reads and searches stay available - a truncated run still has to be able to look around.
    for (const action of ["read", "list", "grep", "glob", "edit", "delete", "outline"]) {
      expect(callWouldPersistContent("filesystem", { action }), action).toBe(false);
    }
    expect(callWouldPersistContent("shell", { command: "npm test" })).toBe(false);
    expect(callWouldPersistContent("todo", { action: "write" })).toBe(false);
  });
});
