import type { ToolExecutor } from "@ducki/shared";
import { filesystemTool } from "./filesystem.js";
import { httpTool } from "./http.js";
import { gitTool } from "./git.js";
import { browserTool } from "./browser.js";
import { shellTool } from "./shell.js";
import { skillsTool } from "./skills.js";
import { weatherTool } from "./weather.js";
import { diagnosticsTool } from "./diagnostics.js";

export { filesystemTool, httpTool, gitTool, browserTool, shellTool, skillsTool, weatherTool, diagnosticsTool };
export { runDiagnostics, invalidateDiagnosticsCache } from "./diagnostics.js";
export type { Diagnostic } from "./diagnostics.js";
export { browserActivityEvents, browserFrameEvents } from "./browser.js";
export {
  createDataSourceTool,
  fetchJson,
  TtlCache,
  hostAllowed,
  getPath,
  interpolate,
} from "./data-source-tool.js";
export type { DataSourceToolConfig, DataSourceRequestStep, DataSourceParamSpec } from "./data-source-tool.js";
export { FILESYSTEM_ACTIONS, FILE_CONTENT_FIELDS, extractFileContent, stripOuterFileBlockMarkers, stripLineNumberPrefixes, EMPTY_CONTENT_ERROR, isIntentionalEmptyWrite, listIncompletePartSequences, clearIncompletePartSequences } from "./filesystem.js";
export type { FilesystemAction } from "./filesystem.js";
export { SHARED_WORKSPACE_ROOT, CODING_WORKSPACE_ROOT } from "./workspace-root.js";
export { stopAllBackgroundProcesses } from "./shell.js";
export { stripStopMarkers, stripTrailingJsonArgTail, CONTENT_STOP_MARKERS } from "./content-sanitizer.js";
export { globFiles, grepFiles, DEFAULT_IGNORED_DIRS } from "./filesystem-search.js";
export type { GrepMatch, GlobOptions, GrepOptions } from "./filesystem-search.js";
export { outlineFile, renderOutline } from "./outline.js";
export type { OutlineResult, SymbolEntry } from "./outline.js";
export { runScriptInSandbox, sanitizeRuntimeValue } from "./sandbox.js";
export type { SandboxRuntime, SandboxVarNames, SandboxExecutionResult } from "./sandbox.js";
export { safeRelativePath, frontmatterScript, extractInlineScript, resolveScriptSource } from "./script-source.js";
export type { ResolveScriptSourceOptions, ResolveScriptSourceResult } from "./script-source.js";
export {
  SKILL_SCRIPT_MAPPINGS,
  getScriptPath,
  buildScriptMappingFromManifest,
  registerScriptMapping,
  listScriptMappings,
  getSkillScripts,
} from "./script-mappings.js";
export type { ScriptMapping } from "./script-mappings.js";

export const allTools: ToolExecutor[] = [filesystemTool, httpTool, gitTool, browserTool, shellTool, skillsTool, weatherTool, diagnosticsTool];

export function getToolByName(name: string): ToolExecutor | undefined {
  return allTools.find((t) => t.name === name);
}
