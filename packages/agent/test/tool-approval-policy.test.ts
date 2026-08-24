import { describe, it, expect } from "vitest";
import {
  ToolApprovalPolicy,
  AllowedShellCommands,
  RequireConfirmation,
  type ToolApprovalRule,
} from "../src/tools/tool-approval-policy";

describe("ToolApprovalPolicy", () => {
  it("preserves confirmation requirements from approval rules", async () => {
    const policy = new ToolApprovalPolicy([
      new RequireConfirmation("filesystem", undefined, "Please confirm this write"),
    ]);

    const result = await policy.check("filesystem", { action: "write", path: "foo.txt" });

    expect(result.approved).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.reason).toBe("Please confirm this write");
  });

  it("preserves corrected input and passes it to subsequent rules", async () => {
    let seenBySecondRule: Record<string, unknown> | undefined;

    const normaliseRule: ToolApprovalRule = {
      name: "normalise-path",
      async check(_toolName, input) {
        return {
          approved: true,
          corrected: { ...input, path: "safe/file.txt" },
        };
      },
    };

    const inspectRule: ToolApprovalRule = {
      name: "inspect-normalised-path",
      async check(_toolName, input) {
        seenBySecondRule = input;
        return { approved: true };
      },
    };

    const policy = new ToolApprovalPolicy([normaliseRule, inspectRule]);
    const result = await policy.check("filesystem", { action: "write", path: "../unsafe.txt" });

    expect(seenBySecondRule?.path).toBe("safe/file.txt");
    expect(result.approved).toBe(true);
    expect(result.corrected?.path).toBe("safe/file.txt");
  });

  it.each(["all_must_approve", "any_deny_blocks"] as const)(
    "%s rejects when any rule denies",
    async (strategy) => {
      const allowRule: ToolApprovalRule = {
        name: "allow",
        async check() {
          return { approved: true };
        },
      };
      const denyRule: ToolApprovalRule = {
        name: "deny",
        async check() {
          return { approved: false, reason: "blocked" };
        },
      };

      const policy = new ToolApprovalPolicy([allowRule, denyRule], strategy);
      const result = await policy.check("shell", { command: "npm test" });

      expect(result.approved).toBe(false);
      expect(result.reason).toBe("blocked");
    }
  );

  it("fails closed when a rule throws", async () => {
    const explodingRule: ToolApprovalRule = {
      name: "explode",
      async check() {
        throw new Error("boom");
      },
    };

    const policy = new ToolApprovalPolicy([explodingRule]);
    const result = await policy.check("shell", { command: "npm test" });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("explode");
    expect(result.reason).toContain("boom");
  });
});

describe("AllowedShellCommands", () => {
  const policy = new ToolApprovalPolicy([
    new AllowedShellCommands(["ls", "pwd", "cat", "npm", "git", "node"], "Only safe shell commands allowed"),
  ]);

  it("approves a leading command that is on the allowlist", async () => {
    const result = await policy.check("shell", { command: "npm test" });
    expect(result.approved).toBe(true);
  });

  it("approves node (needed for the plugin-creation verify step)", async () => {
    const result = await policy.check("shell", { command: 'node "validate-cli.js" "plugins" "my-plugin"' });
    expect(result.approved).toBe(true);
  });

  it("denies a leading command not on the allowlist", async () => {
    const result = await policy.check("shell", { command: "rm -rf /" });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("rm");
  });

  it("denies a chained command where any segment is disallowed", async () => {
    const result = await policy.check("shell", { command: "npm test && rm -rf /" });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("rm");
  });

  it("denies an empty command", async () => {
    const result = await policy.check("shell", { command: "" });
    expect(result.approved).toBe(false);
  });

  it("does not restrict non-shell tools", async () => {
    const result = await policy.check("filesystem", { action: "read", path: "foo.txt" });
    expect(result.approved).toBe(true);
  });
});
