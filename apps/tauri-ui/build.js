#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (msg) => console.log(`[build] ${msg}`);

// tauri-ui is a pure UI client: it embeds the built web app (apps/web/dist) via
// tauri.conf.json's frontendDist and connects to a running backend (local agent on
// http://localhost:3001 or a remote one configured in the Settings UI). There is NO
// server sidecar and NO node_modules bundling - the web app itself resolves the backend
// origin (lib/backendUrl.ts: isDesktopApp() + getApiBaseUrl()).
log('Preparing DucKI UI (web frontend only) for packaging...');

const webDistSrc = path.join(__dirname, '../web/dist');
if (!fs.existsSync(webDistSrc)) {
  log('✗ Web dist not found at apps/web/dist - run "pnpm build:web" first. Aborting.');
  process.exit(1);
}

// Sanity: the build must contain the SPA entry.
const indexPath = path.join(webDistSrc, 'index.html');
if (!fs.existsSync(indexPath)) {
  log('✗ apps/web/dist/index.html missing - the web build looks incomplete. Aborting.');
  process.exit(1);
}

log('✓ Web dist found (apps/web/dist) - will be embedded via frontendDist');
log('✓ Build preparation complete - DucKI UI runs as a standalone UI client');
