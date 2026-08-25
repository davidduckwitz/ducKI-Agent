#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (msg) => console.log(`[build] ${msg}`);

log('Preparing Tauri application for packaging...');

// Paths - Server only (no web frontend)
const distDir = path.join(__dirname, 'dist');
const serverDistSrc = path.join(__dirname, '../server/dist');
const serverDistDest = path.join(__dirname, 'src-tauri/resources/server-dist');

// Helper to copy directories recursively
function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    return false;
  }

  fs.mkdirSync(dest, { recursive: true });
  const files = fs.readdirSync(src);

  files.forEach((file) => {
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);
    const stat = fs.statSync(srcPath);

    if (stat.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  });

  return true;
}

// Copy server dist for bundling with Tauri
if (copyRecursive(serverDistSrc, serverDistDest)) {
  log('✓ Server dist copied to Tauri resources');
} else {
  log('⚠ Server dist not found - make sure to run "pnpm build:server" first!');
}

// The server resolves core prompts and skills from its writable cwd at runtime.
const coreRuntimeDest = path.join(serverDistDest, 'core-runtime');
fs.rmSync(coreRuntimeDest, { recursive: true, force: true });
for (const dirName of ['prompts', 'skills']) {
  const source = path.join(__dirname, '../server', dirName);
  if (!copyRecursive(source, path.join(coreRuntimeDest, dirName))) {
    log(`✗ Required server runtime directory missing: apps/server/${dirName}`);
    process.exit(1);
  }
}
log('✓ Core prompts and skills bundled for first-run seeding');

// The packaged app runs the server via a bundled Node.js sidecar with no access to the
// monorepo's node_modules (pnpm symlinks don't survive outside the workspace). `pnpm deploy`
// turned out to be too fragile for this repo (legacy mode drops nested workspace deps like
// @libsym/client; modern mode requires a repo-wide lockfile config change). Instead we build the
// standalone node_modules ourselves: copy each @ducki/* workspace package's `dist` in directly
// (source of truth is already built), then let plain `npm install` resolve every *external*
// dependency (merged across @ducki/server and all its workspace deps) into a flat tree.
const workspaceRoot = path.join(__dirname, '../..');
const packagesDir = path.join(workspaceRoot, 'packages');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function packageDirFor(scopedName) {
  // "@ducki/tools" -> packages/tools
  const shortName = scopedName.split('/')[1];
  return path.join(packagesDir, shortName);
}

// Walk the workspace:* dependency graph starting at @ducki/server to find every internal
// package that needs its dist bundled, and collect every external dependency along the way.
const serverPkg = readJson(path.join(__dirname, '../server/package.json'));
const workspacePkgs = new Map(); // name -> { dir, pkgJson }
const externalDeps = new Map(); // name -> version range

function collectDeps(pkgJson) {
  for (const [name, range] of Object.entries(pkgJson.dependencies ?? {})) {
    if (range === 'workspace:*' || name.startsWith('@ducki/')) {
      if (workspacePkgs.has(name)) continue;
      const dir = packageDirFor(name);
      const depPkgJsonPath = path.join(dir, 'package.json');
      if (!fs.existsSync(depPkgJsonPath)) {
        log(`⚠ Workspace package ${name} not found at ${dir} - skipping`);
        continue;
      }
      const depPkgJson = readJson(depPkgJsonPath);
      workspacePkgs.set(name, { dir, pkgJson: depPkgJson });
      collectDeps(depPkgJson);
    } else {
      externalDeps.set(name, range);
    }
  }
}

collectDeps(serverPkg);

// Re-resolving external deps against the live npm registry with loose semver ranges (e.g.
// "^3.500.0") is non-reproducible and can outright fail when a fast-moving package (AWS SDK v3
// splits credentials into dozens of co-versioned sub-packages) briefly has a broken release on
// the registry. The monorepo's pnpm install already resolved every one of these to an exact,
// tested version - reuse that instead of letting npm re-resolve from scratch.
// Try resolving from every package that could plausibly have pulled the dep in - @ducki/server
// itself, then each workspace package in turn (the one that actually declares it as a
// dependency is virtually always able to resolve it via pnpm's per-package node_modules).
const resolveContexts = [
  createRequire(path.join(__dirname, '../server/package.json')),
  ...[...workspacePkgs.values()].map(({ dir }) => createRequire(path.join(dir, 'package.json'))),
];
function pinnedVersion(name, fallbackRange) {
  for (const req of resolveContexts) {
    try {
      const pkgJsonPath = req.resolve(`${name}/package.json`);
      return readJson(pkgJsonPath).version;
    } catch {
      // try the next context
    }
  }
  log(`⚠ Could not resolve installed version of ${name} from the monorepo - falling back to range "${fallbackRange}"`);
  return fallbackRange;
}
for (const [name, range] of externalDeps) {
  externalDeps.set(name, pinnedVersion(name, range));
}

log(`\n📦 Bundling ${workspacePkgs.size} workspace package(s) + ${externalDeps.size} external dependencies...`);

const nodeModulesDest = path.join(serverDistDest, 'node_modules');
fs.rmSync(nodeModulesDest, { recursive: true, force: true });

// Synthetic package.json with only external deps - npm resolves these into a real,
// non-symlinked node_modules tree, including nested-only deps like @libsql/client.
fs.writeFileSync(
  path.join(serverDistDest, 'package.json'),
  JSON.stringify(
    {
      name: '@ducki/server-dist',
      version: serverPkg.version,
      private: true,
      type: 'module',
      main: 'index.js',
      dependencies: Object.fromEntries(externalDeps),
    },
    null,
    2
  )
);

log('📦 Running "npm install" for external dependencies (this can take a while)...');
const npmInstallResult = spawnSync(
  'npm',
  ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'],
  { cwd: serverDistDest, stdio: 'inherit', shell: true }
);

if (npmInstallResult.status !== 0) {
  log('✗ "npm install" failed - resources/server-dist/node_modules would be incomplete. Aborting.');
  process.exit(1);
}
log('✓ External dependencies installed into resources/server-dist/node_modules');

// npm treats anything in node_modules that isn't one of ITS OWN dependencies as extraneous and
// prunes it during install - so the @ducki/* workspace packages must be copied in AFTER npm runs,
// never before.
fs.mkdirSync(path.join(nodeModulesDest, '@ducki'), { recursive: true });

for (const [name, { dir, pkgJson }] of workspacePkgs) {
  const shortName = name.split('/')[1];
  const destDir = path.join(nodeModulesDest, '@ducki', shortName);
  const distOk = copyRecursive(path.join(dir, 'dist'), path.join(destDir, 'dist'));
  if (!distOk) {
    log(`⚠ ${name} has no built dist/ - run "pnpm build:server" first`);
  }
  // Minimal package.json so Node's ESM resolver can find the entry point/exports.
  fs.writeFileSync(
    path.join(destDir, 'package.json'),
    JSON.stringify(
      { name, version: pkgJson.version, type: pkgJson.type ?? 'module', main: pkgJson.main, exports: pkgJson.exports },
      null,
      2
    )
  );
}
log(`✓ Copied ${workspacePkgs.size} workspace package(s) into node_modules/@ducki`);

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
// package INTO the plugin folder (plugins-builtin/<plugin>/node_modules/<name>) so it
// resolves from the plugin itself.
const serverRequire = createRequire(path.join(__dirname, '../server/package.json'));
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
function bundleRuntimePackage(spec, pluginDest, resolver, seen) {
  if (seen.has(spec)) return;
  const pkgJsonPath = resolvePackageJson(spec, resolver);
  const pkgJson = readJson(pkgJsonPath);
  const pkgDir = path.dirname(pkgJsonPath);
  seen.add(spec);
  copyRuntimePackage(pkgDir, path.join(pluginDest, 'node_modules', spec));

  const nestedResolver = createRequire(pkgJsonPath);
  const nested = { ...(pkgJson.dependencies ?? {}), ...(pkgJson.optionalDependencies ?? {}) };
  for (const child of Object.keys(nested)) {
    try {
      bundleRuntimePackage(child, pluginDest, nestedResolver, seen);
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
  for (const entry of fs.readdirSync(pluginsSrc, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // skips .secret-key, .state.json (both plain files)
    const pluginDest = path.join(pluginsDest, entry.name);
    copyRecursive(path.join(pluginsSrc, entry.name), pluginDest);
    pluginCount += 1;
    const bundledSpecs = new Set();
    for (const spec of bareExternalImports(path.join(pluginsSrc, entry.name))) {
      try {
        bundleRuntimePackage(spec, pluginDest, serverRequire, bundledSpecs);
        depBundled += 1;
        log(`  ↳ bundled runtime dep "${spec}" into plugin ${entry.name}`);
      } catch {
        log(`⚠ Could not resolve runtime dep "${spec}" for plugin ${entry.name} - it will fail to load in the packaged app`);
      }
    }
  }
  log(`✓ Bundled ${pluginCount} built-in plugin(s) (+${depBundled} runtime dep(s)) into resources/server-dist/plugins-builtin`);
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

log('\n✓ Build preparation complete - Server will run via the bundled Node.js sidecar');
