/**
 * Tool approval policies: runtime-modifiable rules that gate tool execution.
 * Enables security policies, input validation, and tool-specific restrictions.
 */

/**
 * Result of an approval rule check.
 */
export interface ApprovalCheckResult {
  approved: boolean;
  reason?: string;
  /** If approved, may contain corrected input to use instead of original */
  corrected?: Record<string, unknown>;
  /** If approval requires user confirmation, set this to true */
  requiresConfirmation?: boolean;
}

/**
 * A single approval rule that checks whether a tool call should be allowed.
 */
export interface ToolApprovalRule {
  name: string;
  description?: string;
  /** Check if this tool call should be approved */
  check(toolName: string, input: Record<string, unknown>): Promise<ApprovalCheckResult>;
}

/**
 * Strategy for combining multiple approval rules.
 */
export type ApprovalStrategy = "all_must_approve" | "any_deny_blocks" | "first_deny_wins";

/**
 * A collection of approval rules with execution strategy.
 */
export class ToolApprovalPolicy {
  constructor(
    readonly rules: ToolApprovalRule[] = [],
    readonly strategy: ApprovalStrategy = "first_deny_wins"
  ) {}

  /**
   * Check if a tool call is approved by the configured rules.
   *
   * Rules are evaluated against the effective input produced by the previous
   * rule. This is important for normalisation/sanitisation rules: later rules
   * must validate the value that would actually be executed, not the original
   * uncorrected input.
   *
   * Denials are fail-closed for every strategy. `first_deny_wins` short-circuits
   * immediately; the other strategies evaluate all rules and reject if any rule
   * denied the call. Confirmation requirements are OR-combined and corrected
   * input is preserved in the final result.
   */
  async check(toolName: string, input: Record<string, unknown>): Promise<ApprovalCheckResult> {
    if (this.rules.length === 0) {
      return { approved: true };
    }

    let effectiveInput = input;
    let wasCorrected = false;
    let requiresConfirmation = false;
    let confirmationReason: string | undefined;
    const deniedResults: ApprovalCheckResult[] = [];

    for (const rule of this.rules) {
      let result: ApprovalCheckResult;
      try {
        result = await rule.check(toolName, effectiveInput);
      } catch (error) {
        return {
          approved: false,
          reason: `Approval rule '${rule.name}' failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (!result.approved) {
        if (this.strategy === "first_deny_wins") {
          return result;
        }
        deniedResults.push(result);
        continue;
      }

      if (result.corrected) {
        effectiveInput = result.corrected;
        wasCorrected = true;
      }

      if (result.requiresConfirmation) {
        requiresConfirmation = true;
        confirmationReason ??= result.reason;
      }
    }

    // With the current boolean rule contract, both aggregate strategies are
    // fail-closed when any rule denies. Keeping both names preserves the public
    // API while `first_deny_wins` remains the only short-circuiting strategy.
    if (
      (this.strategy === "all_must_approve" || this.strategy === "any_deny_blocks") &&
      deniedResults.length > 0
    ) {
      return deniedResults[0]!;
    }

    return {
      approved: true,
      ...(wasCorrected ? { corrected: effectiveInput } : {}),
      ...(requiresConfirmation ? { requiresConfirmation: true, ...(confirmationReason ? { reason: confirmationReason } : {}) } : {}),
    };
  }

  /**
   * Add a rule to this policy.
   */
  addRule(rule: ToolApprovalRule): void {
    this.rules.push(rule);
  }

  /**
   * Remove a rule by name.
   */
  removeRule(name: string): boolean {
    const index = this.rules.findIndex((r) => r.name === name);
    if (index === -1) return false;
    this.rules.splice(index, 1);
    return true;
  }
}

/**
 * Built-in approval rules
 */

/**
 * Denies tool calls matching a pattern.
 */
export class DenyInputPattern implements ToolApprovalRule {
  readonly name: string;
  readonly description: string;

  constructor(
    readonly toolName: string,
    readonly inputPattern: RegExp,
    readonly reason: string
  ) {
    this.name = `deny-${toolName}-pattern`;
    this.description = `Deny ${toolName} calls matching ${inputPattern}`;
  }

  async check(toolName: string, input: Record<string, unknown>): Promise<ApprovalCheckResult> {
    if (toolName !== this.toolName) return { approved: true };

    // Check all input values as strings
    const inputStr = JSON.stringify(input);
    if (this.inputPattern.test(inputStr)) {
      return { approved: false, reason: this.reason };
    }

    return { approved: true };
  }
}

/**
 * Denies specific tools entirely.
 */
export class DenyTool implements ToolApprovalRule {
  readonly name: string;
  readonly description: string;

  constructor(readonly toolName: string, readonly reason: string = "Tool is disabled") {
    this.name = `deny-${toolName}`;
    this.description = `Deny all ${toolName} calls`;
  }

  async check(toolName: string, _input: Record<string, unknown>): Promise<ApprovalCheckResult> {
    if (toolName === this.toolName) {
      return { approved: false, reason: this.reason };
    }
    return { approved: true };
  }
}

/**
 * Restricts the `shell` tool to a leading-command allowlist. Unlike `AllowedActions`, which
 * checks an `action` field, the shell tool takes a free-form `command` string with no `action`
 * - checking `input.action` against it always sees `""` and denies every call. This rule checks
 * the actual leading executable of each `&&`/`;`/`|`/`||`-separated segment instead, so a chained
 * command like "npm test && rm -rf /" is rejected unless every segment's leading command is
 * allowed (not just the first one).
 */
export class AllowedShellCommands implements ToolApprovalRule {
  readonly name = "allowed-shell-commands";
  readonly description: string;

  constructor(readonly commands: string[], readonly reason: string = "Shell command not allowed") {
    this.description = `Allow only these leading commands in a shell call: ${commands.join(", ")}`;
  }

  async check(toolName: string, input: Record<string, unknown>): Promise<ApprovalCheckResult> {
    if (toolName !== "shell") return { approved: true };

    // Managing a background process the agent already started (read its output, stop it, list
    // them) carries no command to whitelist - the command was vetted when it was started.
    const managementAction = String(input["action"] ?? "").toLowerCase();
    if (["output", "stop", "list"].includes(managementAction)) return { approved: true };

    const command = String(input["command"] ?? "").trim();
    if (!command) return { approved: false, reason: "Empty shell command" };

    const allowed = new Set(this.commands.map((c) => c.toLowerCase()));
    const segments = command.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
    for (const segment of segments) {
      const leading = (segment.split(/\s+/)[0] ?? "").toLowerCase();
      if (!allowed.has(leading)) {
        return { approved: false, reason: `${this.reason}: '${leading}'` };
      }
    }
    return { approved: true };
  }
}

/**
 * Requires confirmation for specific tool/action combinations.
 */
export class RequireConfirmation implements ToolApprovalRule {
  readonly name: string;
  readonly description: string;

  constructor(
    readonly toolName: string,
    readonly actionPattern?: RegExp,
    readonly reason: string = "Requires confirmation"
  ) {
    this.name = `confirm-${toolName}`;
    this.description = `Require confirmation for ${toolName}`;
  }

  async check(toolName: string, input: Record<string, unknown>): Promise<ApprovalCheckResult> {
    if (toolName !== this.toolName) return { approved: true };

    if (this.actionPattern) {
      const action = String(input.action ?? "");
      if (!this.actionPattern.test(action)) {
        return { approved: true };
      }
    }

    return { approved: true, requiresConfirmation: true, reason: this.reason };
  }
}

/**
 * Allows only specific actions on a tool.
 */
export class AllowedActions implements ToolApprovalRule {
  readonly name: string;
  readonly description: string;

  constructor(readonly toolName: string, readonly actions: string[], readonly reason: string = "Action not allowed") {
    this.name = `allowed-actions-${toolName}`;
    this.description = `Allow only ${actions.join(", ")} on ${toolName}`;
  }

  async check(toolName: string, input: Record<string, unknown>): Promise<ApprovalCheckResult> {
    if (toolName !== this.toolName) return { approved: true };

    const action = String(input.action ?? "").toLowerCase();
    if (!this.actions.some((a) => a.toLowerCase() === action)) {
      return { approved: false, reason: `${this.reason}: ${action}` };
    }

    return { approved: true };
  }
}
