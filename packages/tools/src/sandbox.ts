import { Script, createContext } from "node:vm";

export interface SandboxRuntime {
  input?: unknown;
  context?: unknown;
}

export interface SandboxVarNames {
  inputVar?: string;
  contextVar?: string;
}

export interface SandboxExecutionResult {
  logs: string[];
  result: unknown;
}

export function sanitizeRuntimeValue(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    throw new Error("Runtime payload is too deeply nested");
  }
  if (value === null || value === undefined) return value;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) {
      throw new Error("Runtime payload array too large");
    }
    return value.map((item) => sanitizeRuntimeValue(item, depth + 1));
  }
  if (valueType === "object") {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    if (keys.length > 200) {
      throw new Error("Runtime payload object too large");
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = sanitizeRuntimeValue(source[key], depth + 1);
    }
    return result;
  }

  throw new Error("Runtime payload contains unsupported value type");
}

/**
 * Runs an untrusted script in a locked-down node:vm context with a 1500ms timeout.
 * `varNames` controls the global variable names the script sees for input/context,
 * so different callers (skills, dynamic tools) can use their own naming convention
 * while sharing this one sandboxed-eval surface.
 */
export function runScriptInSandbox(
  script: string,
  runtime?: SandboxRuntime,
  varNames?: SandboxVarNames
): SandboxExecutionResult {
  const inputVar = varNames?.inputVar ?? "skillInput";
  const contextVar = varNames?.contextVar ?? "skillContext";

  const logs: string[] = [];
  const logger = (...args: unknown[]) => {
    logs.push(
      args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" ")
    );
  };

  const context = createContext({
    console: { log: logger, info: logger, warn: logger, error: logger },
    Date,
    Intl,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    URL,
    URLSearchParams,
    [inputVar]: sanitizeRuntimeValue(runtime?.input),
    [contextVar]: sanitizeRuntimeValue(runtime?.context),
  });
  const wrappedScript = `(function () {\n"use strict";\n${script}\n})();`;
  const vmScript = new Script(wrappedScript);
  return {
    logs,
    result: vmScript.runInContext(context, { timeout: 1500 }),
  };
}
