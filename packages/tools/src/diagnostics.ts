import type { ToolResult, ToolExecutor } from "@ducki/shared";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  code?: string;
  message: string;
}

/**
 * A TypeScript LanguageService kept alive per project root.
 *
 * This is the whole point of the tool. `tsc --noEmit` re-reads and re-checks the entire program
 * on every invocation - tens of seconds on a monorepo - which is why a build can only realistically
 * run once, at the very end of an attempt. A LanguageService parses the program once and then only
 * re-parses the files whose version changed, so the second and every later call costs milliseconds.
 * That turns "find out at the end of the attempt whether the edit compiled" into "find out
 * immediately after the edit", which is the single biggest difference between a coding agent that
 * converges and one that burns its retry budget.
 */
interface ProjectService {
  service: import("typescript").LanguageService;
  ts: typeof import("typescript");
  /** mtimeMs per file, so the service only re-reads what actually changed. */
  versions: Map<string, number>;
  fileNames: string[];
  rootPath: string;
  configPath: string;
}

const serviceCache = new Map<string, ProjectService | null>();

/** Load the PROJECT's own typescript if it has one, so diagnostics match its compiler version. */
function loadTypeScript(rootPath: string): typeof import("typescript") | undefined {
  const candidates = [join(rootPath, "package.json"), join(rootPath, "noop.js")];
  for (const from of candidates) {
    try {
      const req = createRequire(from);
      return req("typescript") as typeof import("typescript");
    } catch {
      // try the next resolution base
    }
  }
  try {
    // Fall back to the copy shipped alongside this package.
    return createRequire(import.meta.url)("typescript") as typeof import("typescript");
  } catch {
    return undefined;
  }
}

function fileVersion(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Finds the tsconfig that actually governs a FILE, by walking up from the file's own directory.
 *
 * Looking it up from the project root instead is wrong in every monorepo: the root
 * tsconfig.json there is a solution file (`"files": []` plus `references`), so it compiles
 * nothing at all - the type-check would silently check zero files and cheerfully report no
 * errors, which is the worst possible answer from a verification tool.
 */
function findConfigForFile(
  ts: typeof import("typescript"),
  filePath: string,
  rootPath: string
): string | undefined {
  return ts.findConfigFile(dirname(filePath), ts.sys.fileExists, "tsconfig.json")
    ?? ts.findConfigFile(rootPath, ts.sys.fileExists, "tsconfig.json");
}

function createProjectService(
  ts: typeof import("typescript"),
  configPath: string,
  rootPath: string,
  requestedFiles: string[]
): ProjectService | null {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) return null;

  const configDir = dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configDir);

  // A solution-style config resolves to no files. Its compilerOptions are still the right ones,
  // so keep them and use the requested files as the program roots instead of giving up.
  const fileNames = parsed.fileNames.length > 0 ? [...parsed.fileNames] : [...requestedFiles];
  if (fileNames.length === 0) return null;

  const versions = new Map<string, number>();
  for (const fileName of fileNames) versions.set(fileName, fileVersion(fileName));

  const state = { fileNames };

  const host: import("typescript").LanguageServiceHost = {
    getScriptFileNames: () => state.fileNames,
    getScriptVersion: (fileName) => String(versions.get(fileName) ?? fileVersion(fileName)),
    getScriptSnapshot: (fileName) => {
      try {
        return ts.ScriptSnapshot.fromString(readFileSync(fileName, "utf8"));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => configDir,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  return {
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
    ts,
    versions,
    fileNames: state.fileNames,
    rootPath,
    configPath,
  };
}

function getProjectService(
  ts: typeof import("typescript"),
  configPath: string,
  rootPath: string,
  requestedFiles: string[]
): ProjectService | null {
  const cacheKey = configPath;
  if (!serviceCache.has(cacheKey)) {
    let created: ProjectService | null = null;
    try {
      created = createProjectService(ts, configPath, rootPath, requestedFiles);
    } catch {
      created = null;
    }
    serviceCache.set(cacheKey, created);
  }
  return serviceCache.get(cacheKey) ?? null;
}

/** Drops every warm compiler. Called when the file SET may have changed (files created or
 *  deleted outside the agent), which a version bump alone cannot express. */
export function invalidateDiagnosticsCache(_rootPath?: string): void {
  serviceCache.clear();
}

function toDiagnostic(
  ts: typeof import("typescript"),
  diagnostic: import("typescript").Diagnostic,
  rootPath: string
): Diagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  const severity: Diagnostic["severity"] =
    diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning";

  if (!diagnostic.file || diagnostic.start === undefined) {
    return { file: "", line: 0, column: 0, severity, code: `TS${diagnostic.code}`, message };
  }

  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    file: relative(rootPath, diagnostic.file.fileName).replace(/\\/g, "/"),
    line: line + 1,
    column: character + 1,
    severity,
    code: `TS${diagnostic.code}`,
    message,
  };
}

function checkWithTypeScript(
  rootPath: string,
  files: string[]
): { diagnostics: Diagnostic[]; checkers: string[]; checkedFiles: string[]; unchecked: string[] } | undefined {
  const ts = loadTypeScript(rootPath);
  if (!ts) return undefined;

  // Files are grouped by the tsconfig that governs them, so a monorepo touched across two
  // packages in one run gets each file checked with ITS package's compiler options rather than
  // whichever config happened to be found first.
  const byConfig = new Map<string, string[]>();
  const unchecked: string[] = [];
  for (const file of files) {
    const configPath = findConfigForFile(ts, file, rootPath);
    if (!configPath) {
      unchecked.push(file);
      continue;
    }
    const group = byConfig.get(configPath);
    if (group) group.push(file);
    else byConfig.set(configPath, [file]);
  }

  if (byConfig.size === 0) return { diagnostics: [], checkers: [], checkedFiles: [], unchecked };

  const diagnostics: Diagnostic[] = [];
  const checkers = new Set<string>();
  const checkedFiles: string[] = [];

  for (const [configPath, groupFiles] of byConfig) {
    const project = getProjectService(ts, configPath, rootPath, groupFiles);
    if (!project) {
      unchecked.push(...groupFiles);
      continue;
    }

    const { service, versions } = project;

    // Refresh versions so the service re-parses exactly the files that changed since last call.
    for (const file of groupFiles) {
      versions.set(file, fileVersion(file));
      if (!project.fileNames.includes(file)) project.fileNames.push(file);
    }

    for (const file of groupFiles) {
      try {
        for (const d of service.getSyntacticDiagnostics(file)) diagnostics.push(toDiagnostic(ts, d, rootPath));
        for (const d of service.getSemanticDiagnostics(file)) diagnostics.push(toDiagnostic(ts, d, rootPath));
        checkedFiles.push(file);
      } catch (error) {
        diagnostics.push({
          file: relative(rootPath, file).replace(/\\/g, "/"),
          line: 0,
          column: 0,
          severity: "warning",
          message: `Could not analyse this file: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    checkers.add(`typescript ${ts.version} (${relative(rootPath, configPath).replace(/\\/g, "/") || "tsconfig.json"})`);
  }

  return { diagnostics, checkers: [...checkers], checkedFiles, unchecked };
}

/** Syntax-only fallback for plain JS - instant, and catches the majority of what a broken edit
 *  produces (unbalanced braces, stray tool-call text, truncated writes). */
function checkJavaScriptSyntax(rootPath: string, file: string): Diagnostic[] {
  try {
    execFileSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 10000, stdio: "pipe" });
    return [];
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    const match = /:(\d+)\r?\n[\s\S]*?\r?\n(\w*Error: .*)/.exec(stderr);
    return [
      {
        file: relative(rootPath, file).replace(/\\/g, "/"),
        line: match ? Number(match[1]) : 0,
        column: 0,
        severity: "error",
        message: match ? match[2]! : stderr.split("\n").slice(0, 3).join(" ").trim() || "Syntax error",
      },
    ];
  }
}

function checkJson(rootPath: string, file: string): Diagnostic[] {
  try {
    JSON.parse(readFileSync(file, "utf8"));
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const positionMatch = /line (\d+) column (\d+)/i.exec(message);
    return [
      {
        file: relative(rootPath, file).replace(/\\/g, "/"),
        line: positionMatch ? Number(positionMatch[1]) : 0,
        column: positionMatch ? Number(positionMatch[2]) : 0,
        severity: "error",
        message,
      },
    ];
  }
}

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const JS_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"];

function hasExtension(file: string, extensions: string[]): boolean {
  const lower = file.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

export function runDiagnostics(rootPath: string, requestedFiles: string[]): {
  diagnostics: Diagnostic[];
  checkers: string[];
  checkedFiles: string[];
  skipped: Array<{ file: string; reason: string }>;
} {
  const root = resolve(rootPath);
  const diagnostics: Diagnostic[] = [];
  const checkers = new Set<string>();
  const checkedFiles: string[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];

  const absoluteFiles = requestedFiles.map((f) => (isAbsolute(f) ? resolve(f) : resolve(root, f)));

  const tsFiles: string[] = [];
  for (const file of absoluteFiles) {
    if (!existsSync(file)) {
      skipped.push({ file, reason: "file does not exist" });
      continue;
    }
    if (hasExtension(file, TS_EXTENSIONS)) {
      tsFiles.push(file);
    } else if (hasExtension(file, JS_EXTENSIONS)) {
      // A JS file inside a TS project (allowJs) is best handled by the language service;
      // otherwise a syntax check is all that is meaningful.
      tsFiles.push(file);
    } else if (file.toLowerCase().endsWith(".json")) {
      diagnostics.push(...checkJson(root, file));
      checkers.add("json parser");
      checkedFiles.push(file);
    } else {
      skipped.push({ file, reason: "no checker for this file type" });
    }
  }

  if (tsFiles.length > 0) {
    const tsResult = checkWithTypeScript(root, tsFiles);
    const leftover = tsResult ? tsResult.unchecked : tsFiles;

    if (tsResult) {
      diagnostics.push(...tsResult.diagnostics);
      for (const checker of tsResult.checkers) checkers.add(checker);
      checkedFiles.push(...tsResult.checkedFiles);
    }

    // Whatever the language service could not take on (no tsconfig anywhere, or no TypeScript
    // installed) still gets a syntax check where Node can give one - and is reported as
    // syntax-only, never silently passed off as a type check.
    for (const file of leftover) {
      if (hasExtension(file, JS_EXTENSIONS)) {
        diagnostics.push(...checkJavaScriptSyntax(root, file));
        checkers.add("node --check (syntax only, types NOT checked)");
        checkedFiles.push(file);
      } else {
        skipped.push({ file, reason: "no tsconfig.json or typescript available - types not checked" });
      }
    }
  }

  return { diagnostics, checkers: [...checkers], checkedFiles, skipped };
}

export const diagnosticsTool: ToolExecutor = {
  name: "diagnostics",
  description:
    "Type-check and syntax-check specific files. Much faster than a full build - use it after every edit.",
  definition: {
    name: "diagnostics",
    description:
      "Report type and syntax errors for the given files, using the project's own TypeScript configuration. " +
      "This is the FAST check: it analyses only the files you name and reuses a warm compiler between calls, " +
      "so it costs a fraction of a full build. Run it immediately after editing a file, and only run the full " +
      "build/verification command once diagnostics come back clean.",
    parameters: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Files to check, relative to the project root. Pass the files you just edited.",
        },
        path: {
          type: "string",
          description: "Optional single file to check, as an alternative to 'files'.",
        },
        projectRoot: {
          type: "string",
          description: "Project root containing tsconfig.json. Defaults to the sandbox/project root.",
        },
        includeWarnings: {
          type: "boolean",
          default: false,
          description: "Also report warnings, not just errors.",
        },
      },
      required: [],
    },
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const rawFiles = Array.isArray(input["files"]) ? (input["files"] as unknown[]).map(String) : [];
    const single = typeof input["path"] === "string" ? [input["path"] as string] : [];
    const files = [...rawFiles, ...single].filter((f) => f.trim() !== "");

    if (files.length === 0) {
      return {
        success: false,
        data: null,
        error: "No files given. Pass files:[\"src/a.ts\", \"src/b.ts\"] - the files you just edited.",
      };
    }

    const projectRoot = typeof input["projectRoot"] === "string" && input["projectRoot"].trim() !== ""
      ? (input["projectRoot"] as string)
      : process.cwd();
    const includeWarnings = input["includeWarnings"] === true;

    try {
      const result = runDiagnostics(projectRoot, files);
      const relevant = includeWarnings
        ? result.diagnostics
        : result.diagnostics.filter((d) => d.severity === "error");

      const errorCount = relevant.filter((d) => d.severity === "error").length;

      return {
        success: true,
        data: {
          ok: errorCount === 0,
          errorCount,
          diagnostics: relevant.map((d) => ({
            ...d,
            // Pre-rendered in the shape every compiler prints, so the model can match it
            // against the numbered lines that the filesystem read action returns.
            location: `${d.file}:${d.line}:${d.column}`,
          })),
          checkedFiles: result.checkedFiles.map((f) => relative(resolve(projectRoot), f).replace(/\\/g, "/")),
          checkers: result.checkers,
          ...(result.skipped.length > 0 ? { skipped: result.skipped } : {}),
          summary:
            errorCount === 0
              ? `No errors in ${result.checkedFiles.length} file(s).`
              : `${errorCount} error(s) found. Fix these before running the full build.`,
        },
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
