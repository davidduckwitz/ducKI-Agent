#!/usr/bin/env node
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let devProcess = null;
let sharedProcess = null;
let isShuttingDown = false;

const log = (msg) => console.log(`[dev] ${msg}`);
const error = (msg) => console.error(`[dev] ❌ ${msg}`);

log('Starting Ducki dev environment...\n');

// First, build shared package once
log('📦 Building @ducki/shared...');
const buildShared = spawnSync('pnpm', ['--filter=@ducki/shared', 'run', 'build'], {
  stdio: 'inherit',
  shell: true
});

if (buildShared.status !== 0) {
  error('Failed to build shared package');
  process.exit(1);
}

log('✅ @ducki/shared built successfully\n');

// Then start shared in watch mode
log('📦 Starting @ducki/shared in watch mode...');
sharedProcess = spawn(
  'pnpm',
  ['--filter=@ducki/shared', 'run', 'dev'],
  { stdio: 'inherit', shell: true }
);

// Start other packages after sufficient delay (shared compilation must be complete)
setTimeout(() => {
  log('\n🚀 Starting remaining packages in parallel...');
  startOtherPackages();
}, 3000);

function startOtherPackages() {
  if (devProcess) return; // Already started

  devProcess = spawn(
    'pnpm',
    ['-r', '--parallel', '--filter=!@ducki/cli', '--filter=!@ducki/shared', '--filter=!@ducki/desktop', '--filter=!@ducki/tauri-desktop', '--filter=!@ducki/tauri-server', 'run', 'dev'],
    { stdio: 'inherit', shell: true }
  );

  devProcess.on('exit', handleExit);
}

const handleExit = (code) => {
  if (!isShuttingDown) {
    log(`Dev process exited with code ${code}`);
    process.exit(code);
  }
};

sharedProcess.on('exit', (code) => {
  if (!isShuttingDown) {
    error(`Shared package watch exited with code ${code}`);
    if (devProcess) devProcess.kill();
    process.exit(code);
  }
});

// Handle signals
process.on('SIGINT', () => {
  isShuttingDown = true;
  log('Shutting down...');
  if (sharedProcess) sharedProcess.kill();
  if (devProcess) devProcess.kill();
  process.exit(0);
});

sharedProcess.on('error', (err) => {
  error(`Failed to start shared watch: ${err.message}`);
  process.exit(1);
});
