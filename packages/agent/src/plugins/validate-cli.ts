import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePluginManifest } from "./plugin-manifest.js";

/**
 * Deterministic safety gate for agent-authored plugins. Used two ways:
 *  - as a `verifyCommand` inside CodingAgent's own attempt loop (CLI mode below), so a
 *    validation failure feeds back into the model's next repair attempt like a failing build;
 *  - as a final, authoritative server-side re-check (`validatePluginDir`) before the created
 *    plugin is ever loaded/reload-visible - never trust the agent's own "verified" claim alone.
 *
 * Deliberately stricter than the manifest schema itself: agent-authored plugins are additionally
 * banned from anything that runs real code (trust:"node", moduleTools, connector) or ships a
 * browser-rendered surface (settingsPage/frontendPage/widgetPage/overlayPage/oauth) - see the
 * plugin-manage skill and the Run Journal/plugin-creation plan for the full rationale.
 */
export interface PluginValidationOptions {
  /** Only for a server-generated, integrity-locked LLM-provider scaffold. */
  allowBuilderLLMProvider?: boolean;
  allowBuilderWidgets?: boolean;
}

export function validatePluginDir(pluginsRoot: string, name: string, options: PluginValidationOptions = {}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const pluginDir = join(pluginsRoot, name);
  const manifestPath = join(pluginDir, "plugin.json");

  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`plugin.json not found at ${manifestPath}`] };
  }

  const raw = readFileSync(manifestPath, "utf8");
  const parsed = parsePluginManifest(raw);
  if (!parsed.ok || !parsed.manifest) {
    return { ok: false, errors: [parsed.error ?? "plugin.json failed schema validation"] };
  }
  const manifest = parsed.manifest;

  if (manifest.name !== name) {
    errors.push(`manifest name "${manifest.name}" must match the plugin directory name "${name}"`);
  }
  const builderLLMProviders = manifest.provides.llmProviders ?? [];
  const allowedBuilderLLM = options.allowBuilderLLMProvider
    && builderLLMProviders.length === 1
    && builderLLMProviders[0]?.module === "provider.js"
    && !(manifest.provides.moduleTools?.length)
    && !manifest.provides.connector;
  if (manifest.trust === "node" && !allowedBuilderLLM) {
    errors.push('trust: "node" is not allowed for agent-authored plugins - use the default "sandboxed"');
  }
  if (builderLLMProviders.length > 0 && !allowedBuilderLLM) {
    errors.push("provides.llmProviders is only allowed for an integrity-locked LLM-provider builder scaffold");
  }
  if (manifest.provides.moduleTools && manifest.provides.moduleTools.length > 0) {
    errors.push("provides.moduleTools is not allowed for agent-authored plugins (runs real Node code)");
  }
  if (manifest.provides.connector) {
    errors.push("provides.connector is not allowed for agent-authored plugins (requires trust:\"node\")");
  }
  const bannedSurfaces: Array<[string, unknown]> = [
    ["provides.oauth", manifest.provides.oauth],
    ["provides.settingsPage", manifest.provides.settingsPage],
    ["provides.frontendPage", manifest.provides.frontendPage],
    ["provides.widgetPage", manifest.provides.widgetPage],
    ["provides.overlayPage", manifest.provides.overlayPage],
    ...(!options.allowBuilderWidgets ? [["provides.widgets", manifest.provides.widgets] as [string, unknown]] : []),
  ];
  for (const [field, value] of bannedSurfaces) {
    const present = Array.isArray(value) ? value.length > 0 : value !== undefined;
    if (present) {
      errors.push(`${field} is not allowed for agent-authored plugins in v1 (backend tools + skills only)`);
    }
  }

  for (const rel of manifest.provides.scriptTools ?? []) {
    const filePath = join(pluginDir, rel);
    if (!existsSync(filePath)) {
      errors.push(`scriptTools entry "${rel}" does not exist`);
      continue;
    }
    try {
      JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      errors.push(`scriptTools entry "${rel}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const rel of manifest.provides.dataSourceTools ?? []) {
    const filePath = join(pluginDir, rel);
    if (!existsSync(filePath)) {
      errors.push(`dataSourceTools entry "${rel}" does not exist`);
      continue;
    }
    try {
      JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      errors.push(`dataSourceTools entry "${rel}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const widget of manifest.provides.widgets ?? []) {
    if (!existsSync(join(pluginDir, widget.page))) errors.push(`widgets entry "${widget.id}" page does not exist: ${widget.page}`);
  }

  return { ok: errors.length === 0, errors };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  // Also required (not just the URL match): this module gets bundled into the packaged server's
  // single-file build alongside the entry point, where every module shares the bundle's own
  // import.meta.url - so on `node index.js` the URL comparison alone would false-positive and
  // run the CLI branch (argv-less) inside the server, exiting it immediately. The basename check
  // only passes for a real `node .../validate-cli.js <pluginsRoot> <name>` invocation.
  return !!entry && basename(entry) === "validate-cli.js" && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  const [pluginsRootArg, nameArg, ...flags] = process.argv.slice(2);
  if (!pluginsRootArg || !nameArg) {
    console.error("Usage: validate-cli.js <pluginsRoot> <name>");
    process.exit(1);
  }
  const result = validatePluginDir(pluginsRootArg, nameArg, {
    allowBuilderLLMProvider: flags.includes("--allow-builder-llm-provider"),
    allowBuilderWidgets: flags.includes("--allow-builder-widgets"),
  });
  if (result.ok) {
    console.log("PLUGIN_VALID");
    process.exit(0);
  } else {
    console.error("PLUGIN_INVALID:");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
}
