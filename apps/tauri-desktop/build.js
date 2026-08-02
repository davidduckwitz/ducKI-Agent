#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (msg) => console.log(`[build] ${msg}`);

log('Preparing Tauri application for packaging...');

// Paths
const distDir = path.join(__dirname, 'dist');
const webDistSrc = path.join(__dirname, '../web/dist');
const serverDistSrc = path.join(__dirname, '../server/dist');
const webDistDest = path.join(__dirname, 'src-tauri/resources/web-dist');
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

// Compile TypeScript
log('Compiling TypeScript...');
const tsResult = spawnSync('npx', ['tsc'], { stdio: 'inherit', shell: true });
if (tsResult.status !== 0) {
  log('⚠ TypeScript compilation failed or not configured');
}

// Copy web dist for development
if (copyRecursive(webDistSrc, webDistDest)) {
  log('✓ Web files copied to Tauri resources');
} else {
  log('⚠ Web dist not found, skipping...');
}

// Copy server dist for bundling later
if (copyRecursive(serverDistSrc, serverDistDest)) {
  log('✓ Server files copied to Tauri resources');
} else {
  log('⚠ Server dist not found, skipping...');
}

// Bundle server with pkg (optional - try but don't fail if it doesn't work)
log('\nAttempting to bundle server executable with pkg...');
const serverExePath = path.join(serverDistDest, 'server.exe');

// Try pkg first - if it fails, we'll use node fallback in Tauri app
const pkgResult = spawnSync('npx', [
  'pkg',
  path.join(serverDistDest, 'index.js'),
  '--output', serverExePath,
  '--target', 'node18-win-x64',
  '--compress', 'Brotli',
  '--public-packages', '*'  // Include workspace packages
], { stdio: 'pipe', shell: true });

if (pkgResult.status === 0) {
  log('✓ Server executable created with pkg');

  // Copy server.exe to Tauri resources for bundling
  const tauriResourcesDir = path.join(__dirname, 'src-tauri/resources');
  fs.mkdirSync(tauriResourcesDir, { recursive: true });

  const serverExeDest = path.join(tauriResourcesDir, 'server.exe');
  try {
    fs.copyFileSync(serverExePath, serverExeDest);
    log('✓ Server executable copied to Tauri resources');
  } catch (err) {
    log(`⚠ Failed to copy server.exe: ${err.message}`);
  }
} else {
  // pkg failed - that's ok, Tauri will use node fallback
  log('ℹ pkg bundling not available (optional). Tauri app will use node.exe instead');
}

log('✓ Build preparation complete');
