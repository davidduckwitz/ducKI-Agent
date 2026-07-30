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

// Bundle server into executable with pkg
log('\nBundling server executable with pkg...');
const serverExePath = path.join(serverDistDest, 'server.exe');

const pkgResult = spawnSync('npx', [
  'pkg',
  path.join(serverDistDest, 'index.js'),
  '--output', serverExePath,
  '--target', 'node18-win-x64',
  '--compress', 'Brotli'
], { stdio: 'inherit', shell: true });

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
    log(`⚠ Failed to copy server.exe to Tauri resources: ${err.message}`);
  }
} else {
  log('⚠ pkg bundling failed');
}

log('✓ Build preparation complete');
