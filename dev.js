#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isWindows = process.platform === 'win32';
const shell = isWindows ? 'cmd.exe' : '/bin/bash';
const shellArgs = isWindows ? ['/c'] : ['-c'];

console.log('Starting Ducki dev environment...\n');

// Start shared package first in watch mode
console.log('📦 Starting shared package watch...');
const sharedProcess = spawn(
  'pnpm',
  ['-r', '--filter=@ducki/shared', 'run', 'dev'],
  { stdio: 'inherit', shell: true }
);

// Wait a moment for shared to start compiling
setTimeout(() => {
  console.log('\n🚀 Starting remaining packages in parallel...');

  const devProcess = spawn(
    'pnpm',
    ['-r', '--parallel', '--filter=!@ducki/cli', '--filter=!@ducki/shared', 'run', 'dev'],
    { stdio: 'inherit', shell: true }
  );

  // Handle process exits
  const handleExit = (code) => {
    console.log(`Dev process exited with code ${code}`);
    process.exit(code);
  };

  sharedProcess.on('exit', handleExit);
  devProcess.on('exit', handleExit);

  // Handle signals
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    sharedProcess.kill();
    devProcess.kill();
    process.exit(0);
  });
}, 2000);

// Keep parent process alive
sharedProcess.on('error', (err) => {
  console.error('Error starting shared:', err);
  process.exit(1);
});
