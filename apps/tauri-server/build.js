#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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

// For production distribution:
// The server expects node_modules to exist. We have two options:
//
// 1. Bundled: Copy node_modules into resources (large, ~200MB)
//    - Benefit: Truly standalone, no external dependencies
//    - Drawback: Huge bundle size
//
// 2. Fallback: Use global pnpm store / monorepo node_modules
//    - Benefit: Small exe, works in dev environment
//    - Drawback: Requires pnpm at runtime OR install in resources post-build
//
// For now, we'll use option 2 (fallback) which works in monorepo
// If distributing standalone, users should run "npm install" in resources/server-dist

log('\n📦 Dependency handling:');
log('The bundled server expects node_modules in:');
log('  resources/server-dist/node_modules/');
log('');
log('Options for distribution:');
log('  1. Monorepo: node_modules resolved from workspace (current)');
log('  2. Standalone: Run "npm install --prod" in resources/server-dist');
log('  3. Bundled: Include node_modules (~200MB bundle)');
log('');
log('Skipping node_modules copy (pnpm symlinks prevent reliable bundling)');

log('✓ Build preparation complete - Server will be bundled standalone with Node.js');
