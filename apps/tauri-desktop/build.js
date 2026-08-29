#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (msg) => console.log(`[build] ${msg}`);

// Packages that must NOT be esbuild-bundled: each one either ships a native addon/prebuild,
// spawns/locates an external binary relative to its own package directory, or does dynamic
// `require()` calls esbuild can't resolve statically. They stay as real npm-installed packages
// in resources/server-dist/node_modules; everything else gets inlined into one JS file below.
const NATIVE_EXTERNALS = [
  '@libsql/client',
  'tiny-secp256k1',
  'ecpair',
  'mysql2',
  'ffmpeg-static',
  'ffprobe-static',
  'fluent-ffmpeg',
  'nodejs-whisper',
  'yt-dlp-exec',
  'puppeteer-core',
  'bufferutil',
  'utf-8-validate',
  '@aws-sdk/client-bedrock-runtime',
];

log('Preparing DucKI Node (server + desktop) for packaging...');

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    return false;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyRecursive(srcPath, destPath);
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
  external: NATIVE_EXTERNALS,
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
  { cwd: serverDistDest, stdio: 'inherit', shell: true }
);

if (npmInstallResult.status !== 0) {
  log('✗ "npm install" failed - resources/server-dist/node_modules would be incomplete. Aborting.');
  process.exit(1);
}
log('✓ Native/unbundlable dependencies installed into resources/server-dist/node_modules');

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
    copyRecursive(path.join(pluginsSrc, entry.name), pluginDest);
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

// Sidecar binary check
const sidecarPath = path.join(__dirname, 'src-tauri/binaries/node-x86_64-pc-windows-msvc.exe');
if (fs.existsSync(sidecarPath)) {
  log('✓ Node sidecar binary present (src-tauri/binaries/node-x86_64-pc-windows-msvc.exe)');
} else {
  log('⚠ Node sidecar binary MISSING at src-tauri/binaries/node-x86_64-pc-windows-msvc.exe');
  log('  Download a matching portable Node.js build and place it there before "tauri build".');
}

log('\n✓ Build preparation complete - DucKI Node will run server + UI in one process');
