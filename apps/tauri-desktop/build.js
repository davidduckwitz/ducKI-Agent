#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (msg) => console.log(`[build] ${msg}`);

log('Preparing Frontend Tauri application...');

// Paths - Frontend only (no server)
const webDistSrc = path.join(__dirname, '../web/dist');
const webDistDest = path.join(__dirname, 'src-tauri/resources/web-dist');

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

// Copy web frontend
if (copyRecursive(webDistSrc, webDistDest)) {
  log('✓ Web files copied to Tauri resources');
} else {
  log('⚠ Web dist not found, skipping...');
}

log('✓ Build preparation complete');
