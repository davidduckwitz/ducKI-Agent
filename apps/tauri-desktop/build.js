#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (msg) => console.log(`[build] ${msg}`);

// Packages that must NOT be esbuild-bundled: each one either ships a native addon/prebuild,
// spawns/locates an external binary relative to its own package directory, or does dynamic
// `require()` calls esbuild can't resolve statically. They stay as real npm-installed packages
// in resources/server-dist/node_modules; everything else gets inlined into one JS file below.
const NATIVE_EXTERNALS = [
  '@libsql/client',
  'mysql2',
  // yt-dlp-exec is only the JS wrapper - its 18MB yt-dlp.exe is skipped below and installed on
  // demand (Settings > Komponenten), see packages/shared components.ts.
  'fluent-ffmpeg',
  'yt-dlp-exec',
  'bufferutil',
  'utf-8-validate',
];

// External to esbuild but NOT installed: these ship on demand instead of in the installer.
// - ffmpeg-static (~80MB ffmpeg.exe): the "ffmpeg" binary component (gyan.dev build) replaces it;
//   packages/agent/src/media/binaries.ts imports it optionally.
// - the module packs from packages/shared/src/module-packs.ts (puppeteer-core, wallet libraries,
//   nodejs-whisper): every import site goes through loadOptionalModule(), which falls back to
//   the installed pack. The manifest for those packs is generated further down.
// A static import of any of these in the bundle would crash the server at startup - checked below.
const MODULE_PACKS_SRC = path.join(__dirname, '../../packages/shared/dist/module-packs.js');
if (!fs.existsSync(MODULE_PACKS_SRC)) {
  log('✗ packages/shared/dist/module-packs.js missing - run "pnpm build:server" first. Aborting.');
  process.exit(1);
}
const { MODULE_PACKS } = await import(pathToFileURL(MODULE_PACKS_SRC).href);
const PACK_MODULES = Object.values(MODULE_PACKS).flatMap((pack) => pack.modules);
const OPTIONAL_EXTERNALS = ['ffmpeg-static', ...PACK_MODULES];

log('Preparing DucKI Node (server + desktop) for packaging...');

function copyRecursive(src, dest, skip) {
  if (!fs.existsSync(src)) {
    return false;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);
    if (skip && skip(srcPath, file)) continue;
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyRecursive(srcPath, destPath, skip);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  return true;
}

// --- Frontend: tauri.conf.json's frontendDist ("../../web/dist") points straight at the built
// web app, so tauri build embeds it directly - no copy step needed here, just verify it exists.
const webDistSrc = path.join(__dirname, '../web/dist');
if (fs.existsSync(webDistSrc)) {
  log('✓ Web dist found (apps/web/dist) - will be embedded via frontendDist');
} else {
  log('✗ Web dist not found at apps/web/dist - run "pnpm build:web" first. Aborting.');
  process.exit(1);
}

// --- Backend: instead of copying apps/server/dist (~hundreds of compiled files) plus every
// @ducki/* workspace package's dist plus a full `npm install` of ~240 external packages, esbuild
// bundles the server entry point - and every @ducki/* workspace package it imports - into a
// single JS file, resolving pnpm's workspace symlinks at BUILD time (inside the monorepo, where
// they're valid) instead of relying on them surviving into the packaged app. Only packages that
// ship a native addon, spawn/locate a binary relative to their own package dir, or do dynamic
// `require()` calls stay unbundled (NATIVE_EXTERNALS, top of this file) and get a real, plain
// `npm install` - a much smaller install than resolving the entire dependency tree.
const serverEntry = path.join(__dirname, '../server/dist/index.js');
const serverDistDest = path.join(__dirname, 'src-tauri/resources/server-dist');

if (!fs.existsSync(serverEntry)) {
  log('✗ Server dist not found at apps/server/dist - run "pnpm build:server" first. Aborting.');
  process.exit(1);
}
fs.rmSync(serverDistDest, { recursive: true, force: true });
fs.mkdirSync(serverDistDest, { recursive: true });

// Runtime content referenced through process.cwd() by the packaged server. Keep it separate
// from compiled JS so Rust can seed it into the shared writable data directory on first start.
const coreRuntimeDest = path.join(serverDistDest, 'core-runtime');
for (const dirName of ['prompts', 'skills']) {
  const source = path.join(__dirname, '../server', dirName);
  if (!copyRecursive(source, path.join(coreRuntimeDest, dirName))) {
    log(`✗ Required server runtime directory missing: apps/server/${dirName}`);
    process.exit(1);
  }
}
log('✓ Core prompts and skills bundled for first-run seeding');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Not every package exposes `./package.json` through its "exports" map (e.g. @libsql/client), so
// resolving straight to that subpath fails even though the package is installed. Resolve the
// package's real entry point instead and walk upward to the manifest that declares it.
function resolvePackageJson(spec, resolver) {
  for (const base of resolver.resolve.paths(spec) ?? []) {
    const candidate = path.join(base, spec, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        if (readJson(candidate).name === spec) return fs.realpathSync(candidate);
      } catch { /* try regular resolution */ }
    }
  }
  try {
    return resolver.resolve(`${spec}/package.json`);
  } catch {
    // Packages with an exports map often hide package.json (notably @ducki/*). Resolve their
    // public entry and walk upward until the matching manifest is found.
    let current = path.dirname(resolver.resolve(spec));
    while (current !== path.dirname(current)) {
      const candidate = path.join(current, 'package.json');
      if (fs.existsSync(candidate)) {
        try {
          if (readJson(candidate).name === spec) return candidate;
        } catch { /* keep walking */ }
      }
      current = path.dirname(current);
    }
    throw new Error(`Could not resolve package manifest for ${spec}`);
  }
}

const serverPkg = readJson(path.join(__dirname, '../server/package.json'));
const serverRequire = createRequire(path.join(__dirname, '../server/package.json'));

// A NATIVE_EXTERNALS package may be a direct dep of @ducki/server or of one of the workspace
// packages it pulls in (e.g. @libsql/client is only a dependency of @ducki/database) - try
// resolving from every workspace package's own node_modules view, not just the server's.
const packagesDir = path.join(__dirname, '../../packages');
const resolveContexts = [
  serverRequire,
  ...fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(packagesDir, e.name, 'package.json'))
    .filter((p) => fs.existsSync(p))
    .map((p) => createRequire(p)),
];

// Re-resolving native-external deps against the live npm registry with loose semver ranges (e.g.
// "^3.500.0") is non-reproducible and can outright fail when a fast-moving package (AWS SDK v3
// splits credentials into dozens of co-versioned sub-packages) briefly has a broken release on
// the registry. The monorepo's pnpm install already resolved every one of these to an exact,
// tested version - reuse that instead of letting npm re-resolve from scratch.
// ws's own optional native accelerators - never a direct/transitive dependency of anything in
// this monorepo (nothing installs them), so they can't be pinned. They stay in NATIVE_EXTERNALS
// purely so esbuild leaves ws's own guarded `require("bufferutil")` calls alone; ws already
// handles the ensuing "module not found" itself at runtime exactly as it would unbundled.
const OPTIONAL_NATIVE_EXTERNALS = new Set(['bufferutil', 'utf-8-validate']);

function pinnedVersion(name) {
  for (const req of resolveContexts) {
    try {
      return readJson(resolvePackageJson(name, req)).version;
    } catch {
      // try the next context
    }
  }
  if (OPTIONAL_NATIVE_EXTERNALS.has(name)) {
    log(`  (optional native "${name}" not installed - skipping, ws falls back to pure JS)`);
    return null;
  }
  log(`⚠ Could not resolve installed version of ${name} from the monorepo - it must be a dependency reachable from @ducki/server`);
  process.exit(1);
}
const nativeExternalDeps = Object.fromEntries(
  NATIVE_EXTERNALS.map((name) => [name, pinnedVersion(name)]).filter(([, version]) => version !== null)
);

// pdf-parse@1.x picks its pdf.js build with require(`./pdf.js/${options.version}/build/pdf.js`);
// esbuild turns that template into a glob and inlines all four bundled pdf.js versions (~11MB).
// Nothing passes a custom version, so pin the default one.
const pdfParseSingleVersion = {
  name: 'pdf-parse-single-version',
  setup(build) {
    build.onLoad({ filter: /pdf-parse[\\/]lib[\\/]pdf-parse\.js$/ }, async (args) => {
      const src = await fs.promises.readFile(args.path, 'utf8');
      const pinned = src.replace('require(`./pdf.js/${options.version}/build/pdf.js`)', "require('./pdf.js/v1.10.100/build/pdf.js')");
      if (pinned === src) throw new Error('pdf-parse: version require not found - update the pdf-parse-single-version plugin');
      return { contents: pinned, loader: 'js' };
    });
  },
};

log(`\n📦 Bundling the server (esbuild) with ${NATIVE_EXTERNALS.length} native/unbundlable package(s) left external...`);
const bundleResult = await esbuild.build({
  entryPoints: [serverEntry],
  outfile: path.join(serverDistDest, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
  external: [...NATIVE_EXTERNALS, ...OPTIONAL_EXTERNALS],
  plugins: [pdfParseSingleVersion],
  // Some bundled CJS deps guard optional native addons behind a plain `require(...)` (e.g. ws's
  // bufferutil/utf-8-validate lookup). esbuild can't statically resolve those, and its ESM output
  // has no ambient `require` - this banner restores one via Node's own module API so those calls
  // still work (and just throw/catch at runtime exactly as they would unbundled).
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
});
if (bundleResult.errors.length > 0) {
  log('✗ esbuild failed to bundle the server. Aborting.');
  process.exit(1);
}
{
  const bundled = fs.readFileSync(path.join(serverDistDest, 'index.js'), 'utf8');
  const escape = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const staticHits = OPTIONAL_EXTERNALS.filter((spec) =>
    new RegExp(`^\\s*import\\s[^;]*?from\\s*["']${escape(spec)}["']`, 'm').test(bundled) ||
    new RegExp(`^\\s*import\\s*["']${escape(spec)}["']`, 'm').test(bundled));
  if (staticHits.length > 0) {
    log(`✗ Static import of on-demand package(s) in the bundle: ${staticHits.join(', ')} - use loadOptionalModule(). Aborting.`);
    process.exit(1);
  }
}
log('✓ Server bundled into resources/server-dist/index.js');

// Synthetic package.json with only the native-external deps - npm resolves these into a real,
// non-symlinked node_modules tree, including nested-only deps like @libsql/client's platform packages.
fs.writeFileSync(
  path.join(serverDistDest, 'package.json'),
  JSON.stringify(
    {
      name: '@ducki/server-dist',
      version: serverPkg.version,
      private: true,
      type: 'module',
      main: 'index.js',
      dependencies: nativeExternalDeps,
    },
    null,
    2
  )
);

log('📦 Running "npm install" for native/unbundlable dependencies...');
const npmInstallResult = spawnSync(
  'npm',
  ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'],
  { cwd: serverDistDest, stdio: 'inherit', shell: true, env: { ...process.env, YOUTUBE_DL_SKIP_DOWNLOAD: 'true' } }
);

if (npmInstallResult.status !== 0) {
  log('✗ "npm install" failed - resources/server-dist/node_modules would be incomplete. Aborting.');
  process.exit(1);
}
log('✓ Native/unbundlable dependencies installed into resources/server-dist/node_modules');

// Shrink the installer: drop payload that is never executed at runtime.
function pruneDir(rel, why) {
  const target = path.join(serverDistDest, 'node_modules', rel);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    log(`  ↳ pruned ${rel} (${why})`);
  }
}
pruneDir('yt-dlp-exec/bin', 'yt-dlp.exe is installed on demand');
pruneDir('ffprobe-static', 'ffprobe is optional/on demand');
pruneDir('fluent-ffmpeg/coverage', 'test coverage report');
pruneDir('fluent-ffmpeg/doc', 'API docs');
pruneDir('@types', 'type declarations');

// Never loaded at runtime: source maps, TypeScript declarations, markdown, test coverage.
function dirSize(dir) {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    bytes += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return bytes;
}
function pruneJunk(dir) {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['coverage', '.github'].includes(entry.name)) {
        bytes += dirSize(full);
        fs.rmSync(full, { recursive: true, force: true });
      } else {
        bytes += pruneJunk(full);
      }
    } else if (/\.(map|d\.ts|d\.mts|d\.cts|md|markdown)$/i.test(entry.name)) {
      bytes += fs.statSync(full).size;
      fs.rmSync(full, { force: true });
    }
  }
  return bytes;
}
log(`  ↳ pruned ${(pruneJunk(path.join(serverDistDest, 'node_modules')) / 1e6).toFixed(1)}MB of maps/typings/docs/coverage`);

// --- On-demand packs: pin every module pack to the exact versions this monorepo resolved and
// record tarball URL + integrity for each package in its tree. The app installs exactly these
// (packages/shared/src/module-packs.ts) - no npm and no registry re-resolution on the user's PC.
function packEntries(packId, modules) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ducki-pack-${packId}-`));
  try {
    const dependencies = Object.fromEntries(modules.map((name) => [name, pinnedVersion(name)]));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: `ducki-pack-${packId}`, private: true, dependencies }, null, 2));
    const r = spawnSync('npm', ['install', '--package-lock-only', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: tmp, stdio: 'inherit', shell: true });
    if (r.status !== 0) throw new Error(`npm lock resolution failed for pack ${packId}`);
    const lock = readJson(path.join(tmp, 'package-lock.json'));
    // npm's os/cpu lists: either an allow-list ("win32") or only negations ("!darwin").
    const matches = (list, value) =>
      !list || list.includes(value) || (list.every((x) => x.startsWith('!')) && !list.includes(`!${value}`));
    return Object.entries(lock.packages ?? {})
      .filter(([key, meta]) => key && !meta.dev && !meta.link && meta.resolved && meta.integrity)
      .filter(([, meta]) => matches(meta.os, 'win32') && matches(meta.cpu, 'x64'))
      .map(([key, meta]) => ({ path: key, version: meta.version, resolved: meta.resolved, integrity: meta.integrity }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
const modulePacksManifest = { npm: {}, assets: {} };
for (const [packId, pack] of Object.entries(MODULE_PACKS)) {
  const entries = packEntries(packId, pack.modules);
  modulePacksManifest.npm[packId] = { entries };
  log(`  ↳ module pack "${packId}": ${entries.length} package(s) pinned`);
}

// apps/server/src/routes/plugins.ts validates agent-authored plugins in an isolated child
// process (never trusting the agent's own "verified" claim) by spawning @ducki/agent's
// validate-cli.js, located via `import.meta.resolve("@ducki/agent")`. That only works if
// @ducki/agent still exists as a real, separately-resolvable package - so unlike the rest of
// @ducki/*, it is NOT inlined into the main bundle above; it gets its own tiny standalone bundle
// here instead. (npm prunes anything under node_modules it didn't install itself, so this must
// run after, not before, the npm install above.)
const agentPkgDest = path.join(serverDistDest, 'node_modules/@ducki/agent');
fs.mkdirSync(path.join(agentPkgDest, 'plugins'), { recursive: true });
const validateCliResult = await esbuild.build({
  entryPoints: [path.join(__dirname, '../../packages/agent/dist/plugins/validate-cli.js')],
  outfile: path.join(agentPkgDest, 'plugins/validate-cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
});
if (validateCliResult.errors.length > 0) {
  log('✗ esbuild failed to bundle @ducki/agent validate-cli.js. Aborting.');
  process.exit(1);
}
fs.writeFileSync(
  path.join(agentPkgDest, 'package.json'),
  JSON.stringify({ name: '@ducki/agent', version: serverPkg.version, private: true, type: 'module', exports: './index.js' }, null, 2)
);
fs.writeFileSync(path.join(agentPkgDest, 'index.js'), '// stub: only resolved for its directory, see resolveValidateCliPath() in routes/plugins.ts\n');
log('✓ @ducki/agent validate-cli.js bundled standalone for isolated plugin validation');

// --- Python model servers (faster-whisper STT, Chatterbox, Pocket TTS, Qwen3-TTS): ship the
// scripts + requirements + default reference voices; python-paths.ts finds them here and puts
// the venvs/voices into <duckiHome>/python. Never the dev venvs, logs, tests or __pycache__.
const pyScriptsSrc = path.join(__dirname, '../server/scripts');
const pyScriptsDest = path.join(serverDistDest, 'python-scripts');
fs.mkdirSync(path.join(pyScriptsDest, 'voices'), { recursive: true });
for (const file of fs.readdirSync(pyScriptsSrc)) {
  if ((file.endsWith('.py') && !file.startsWith('test_')) || /^requirements-.+\.txt$/.test(file)) {
    fs.copyFileSync(path.join(pyScriptsSrc, file), path.join(pyScriptsDest, file));
  }
}
for (const file of fs.readdirSync(path.join(pyScriptsSrc, 'voices'))) {
  if (/\.(wav|txt)$/.test(file)) fs.copyFileSync(path.join(pyScriptsSrc, 'voices', file), path.join(pyScriptsDest, 'voices', file));
}
log(`✓ Python model-server scripts bundled into resources/server-dist/python-scripts (${fs.readdirSync(pyScriptsDest).length - 1} files + voices)`);

// --- Built-in plugins: apps/server/plugins/* holds the actual plugin folders (calendar, notes,
// pet-companion, ...) - these are runtime data/code, not part of the tsc build, so they never
// land in dist/ and were previously missing from the packaged app entirely. Bundle them here as
// "plugins-builtin"; main.rs seeds them into the writable app-data plugins dir on first run.
// NEVER bundle .secret-key or .state.json - .secret-key is the AES key for encrypted plugin
// secrets (must be unique per install, not shared from this build machine) and .state.json is
// local runtime state; both are auto-created fresh by the app.
const pluginsSrc = path.join(__dirname, '../server/plugins');
const pluginsDest = path.join(serverDistDest, 'plugins-builtin');
fs.rmSync(pluginsDest, { recursive: true, force: true });

// A plugin's JS may import bare external packages (e.g. discord-connector does
// `import WebSocket from "ws"`). In the monorepo those resolve via pnpm; in the packaged
// app the plugin is seeded to app-data where neither the pnpm store nor the bundled
// server node_modules are reachable (the server runs with cwd=app-data). Bundle each such
// package into a SHARED node_modules directly under plugins-builtin/ (a sibling of every
// per-plugin folder), not into each plugin's own node_modules - Node's module resolution
// walks upward through parent node_modules on its own, so one copy of e.g. ffmpeg-static or
// @ducki/providers is enough for every plugin that needs it (main.rs seeds this shared tree
// alongside the per-plugin dirs at app_data/plugins/node_modules). Deduping this way turned a
// ~1GB plugins-builtin (video-editor and vision-analyzer alone each carrying their own full
// copy of shared deps) into a fraction of that.
function copyRuntimePackage(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory() && ['node_modules', '.git', 'coverage'].includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyRuntimePackage(from, to);
    else fs.copyFileSync(from, to);
  }
}
function bundleRuntimePackage(spec, sharedRoot, resolver, seen) {
  if (seen.has(spec)) return;
  const pkgJsonPath = resolvePackageJson(spec, resolver);
  const pkgJson = readJson(pkgJsonPath);
  const pkgDir = path.dirname(pkgJsonPath);
  seen.add(spec);
  copyRuntimePackage(pkgDir, path.join(sharedRoot, 'node_modules', spec));

  const nestedResolver = createRequire(pkgJsonPath);
  const nested = { ...(pkgJson.dependencies ?? {}), ...(pkgJson.optionalDependencies ?? {}) };
  for (const child of Object.keys(nested)) {
    try {
      bundleRuntimePackage(child, sharedRoot, nestedResolver, seen);
    } catch (error) {
      log(`⚠ Could not bundle transitive runtime dep "${child}" required by "${spec}": ${error.message}`);
    }
  }
}
function bareExternalImports(dir) {
  const found = new Set();
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (/\.(js|mjs|cjs|ts)$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/(?:from\s+|require\s*\(\s*)["']([^"']+)["']/g)) {
          const spec = m[1];
          // Only real bare package names ("ws", "@scope/pkg") - rejects relative
          // paths, "node:" builtins and template-literal fragments ("${x}", " + ").
          if (/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(spec)) found.add(spec);
        }
      }
    }
  }
  walk(dir);
  return [...found];
}

if (fs.existsSync(pluginsSrc)) {
  let pluginCount = 0;
  let depBundled = 0;
  const sharedBundledSpecs = new Set(); // shared across ALL plugins - see bundleRuntimePackage
  for (const entry of fs.readdirSync(pluginsSrc, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // skips .secret-key, .state.json (both plain files)
    const pluginDest = path.join(pluginsDest, entry.name);
    // Never ship the dev machine's runtime data (per-plugin SQLite = Discord/Telegram/GitHub
    // tokens + settings): top-level data/ dir and any stray sqlite/wal/shm files are skipped.
    const pluginRoot = path.join(pluginsSrc, entry.name);
    copyRecursive(pluginRoot, pluginDest, (srcPath, name) =>
      path.dirname(srcPath) === pluginRoot && name === 'data' || /\.sqlite(-wal|-shm)?$/.test(name));
    pluginCount += 1;
    for (const spec of bareExternalImports(path.join(pluginsSrc, entry.name))) {
      const alreadyShared = sharedBundledSpecs.has(spec);
      try {
        bundleRuntimePackage(spec, pluginsDest, serverRequire, sharedBundledSpecs);
        if (!alreadyShared) depBundled += 1;
        log(`  ↳ runtime dep "${spec}" available to plugin ${entry.name} (shared)`);
      } catch {
        log(`⚠ Could not resolve runtime dep "${spec}" for plugin ${entry.name} - it will fail to load in the packaged app`);
      }
    }
  }
  log(`✓ Bundled ${pluginCount} built-in plugin(s) (+${depBundled} shared runtime dep(s)) into resources/server-dist/plugins-builtin`);
} else {
  log('⚠ apps/server/plugins not found - packaged app will start with zero plugins');
}

// --- Monaco's TypeScript worker (~7MB) as an on-demand asset. The desktop web build
// (`vite build --mode desktop`) leaves it out; here it is bundled standalone from the SAME
// monaco-editor version the UI was built with and dropped into update-server/components/, which is
// uploaded with the release (https://ducki.cloud/updates/desktop/components/).
const COMPONENTS_BASE_URL = (process.env.DUCKI_COMPONENTS_BASE_URL || 'https://ducki.cloud/updates/desktop/components').replace(/\/$/, '');
{
  const webRequire = createRequire(path.join(__dirname, '../web/package.json'));
  const monacoPkgJson = resolvePackageJson('monaco-editor', webRequire);
  const monacoVersion = readJson(monacoPkgJson).version;
  const workerBuild = await esbuild.build({
    entryPoints: [path.join(path.dirname(monacoPkgJson), 'esm/vs/language/typescript/ts.worker.js')],
    bundle: true,
    format: 'iife',
    minify: true,
    write: false,
    logLevel: 'warning',
  });
  const code = workerBuild.outputFiles[0].contents;
  const sha256 = crypto.createHash('sha256').update(code).digest('hex');
  const file = `monaco-ts-worker-${monacoVersion}-${sha256.slice(0, 8)}.js`;
  const componentsOut = path.join(__dirname, 'update-server/components');
  fs.mkdirSync(componentsOut, { recursive: true });
  for (const old of fs.readdirSync(componentsOut)) {
    if (old.startsWith('monaco-ts-worker-') && old !== file) fs.rmSync(path.join(componentsOut, old));
  }
  fs.writeFileSync(path.join(componentsOut, file), code);
  modulePacksManifest.assets['monaco-ts'] = { url: `${COMPONENTS_BASE_URL}/${file}`, sha256, file: 'ts.worker.js' };
  log(`✓ Monaco TS worker -> update-server/components/${file} (${(code.length / 1e6).toFixed(1)}MB, upload with the release)`);

  const webAssets = path.join(webDistSrc, 'assets');
  if (fs.existsSync(webAssets) && fs.readdirSync(webAssets).some((f) => f.startsWith('ts.worker'))) {
    log('⚠ apps/web/dist still contains ts.worker - build the UI with "pnpm -w build:web:desktop" to leave it out of the installer');
  }
}

fs.writeFileSync(path.join(serverDistDest, 'module-packs.json'), JSON.stringify(modulePacksManifest, null, 2));
log('✓ module-packs.json written (on-demand components)');

// Seed stamp: the desktop shell re-runs its (additive) prompt/skill/plugin seeding only when this
// changes, instead of walking the whole plugin tree on every launch (see src-tauri/src/seed.rs).
fs.writeFileSync(path.join(serverDistDest, 'BUILD_ID'), `${serverPkg.version}-${Date.now().toString(36)}\n`);
log('✓ BUILD_ID written for first-run seeding');

// Sidecar binary check
const sidecarPath = path.join(__dirname, 'src-tauri/binaries/node-x86_64-pc-windows-msvc.exe');
if (fs.existsSync(sidecarPath)) {
  log('✓ Node sidecar binary present (src-tauri/binaries/node-x86_64-pc-windows-msvc.exe)');
} else {
  log('⚠ Node sidecar binary MISSING at src-tauri/binaries/node-x86_64-pc-windows-msvc.exe');
  log('  Download a matching portable Node.js build and place it there before "tauri build".');
}

log('\n✓ Build preparation complete - DucKI Node will run server + UI in one process');
