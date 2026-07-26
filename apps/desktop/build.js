#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const log = (msg) => console.log(`[build] ${msg}`);

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

// Helper to remove directory recursively (using rimraf via spawn)
function removeRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  spawnSync('npx', ['rimraf', dir], { stdio: 'inherit', shell: true });
}

log('Preparing application for packaging...');

// Paths
const distDir = path.join(__dirname, 'dist');
const webDistSrc = path.join(__dirname, '../web/dist');
const serverDistSrc = path.join(__dirname, '../server/dist');
const webDistDest = path.join(distDir, 'web-dist');
const serverDistDest = path.join(distDir, 'server-dist');

// Clean dist
log('Cleaning dist directory...');
removeRecursive(distDir);
fs.mkdirSync(distDir, { recursive: true });

// Compile TypeScript
log('Compiling TypeScript...');
const tsResult = spawnSync('npx', ['tsc'], { stdio: 'inherit', shell: true });
if (tsResult.status !== 0) {
  log('❌ TypeScript compilation failed');
  process.exit(1);
}

// Copy web dist
if (copyRecursive(webDistSrc, webDistDest)) {
  log('✓ Web files copied');
} else {
  log('⚠ Web dist not found, skipping...');
}

// Copy server dist
if (copyRecursive(serverDistSrc, serverDistDest)) {
  log('✓ Server files copied');
} else {
  log('⚠ Server dist not found, skipping...');
}

// Bundle server into executable with pkg
log('\nBundling server executable with pkg...');
const pkgTarget = 'node18-win-x64'; // Use node18 instead of node20 for better compatibility
const serverExePath = path.join(distDir, 'server-dist', 'server.exe');

const pkgResult = spawnSync('npx', [
  'pkg',
  path.join(serverDistDest, 'index.js'),
  '--output', serverExePath,
  '--target', pkgTarget,
  '--compress', 'Brotli'
], { stdio: 'inherit', shell: true });

if (pkgResult.status === 0) {
  log('✓ Server executable created with pkg');
  // Remove the .js file since we have the .exe now
  try {
    fs.unlinkSync(path.join(serverDistDest, 'index.js'));
    log('✓ Removed index.js (using server.exe)');
  } catch (e) {
    log('⚠ Could not remove index.js');
  }
} else {
  log('⚠ pkg bundling failed - you may need to install pkg manually: npm install -g pkg');
}

log('✓ Build preparation complete');
