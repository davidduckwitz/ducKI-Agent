import { app, BrowserWindow, Menu, Tray, ipcMain, dialog } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Application state
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let backendServer: any = null;
let isQuitting = false;

const BACKEND_PORT = 3001;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const BACKEND_HEALTH_CHECK = `${BACKEND_URL}/health`;

// Get the application path
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const appPath = isDev ? path.join(__dirname, '../..') : process.resourcesPath;

// Setup logging to file
const logDir = path.join(app.getPath('userData'), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const logFile = path.join(logDir, 'ducki.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

// Logging helper
const log = (message: string) => {
  const timestamp = new Date().toISOString();
  const fullMessage = `[${timestamp}] ${message}`;
  console.log(fullMessage);
  logStream.write(fullMessage + '\n');
};

// Start backend server
async function startBackend(): Promise<void> {
  log('Starting backend server...');

  // Check if port is already in use
  try {
    await axios.get(BACKEND_HEALTH_CHECK, { timeout: 1000 });
    log('Backend server already running');
    return;
  } catch {
    // Server not running, start it
  }

  let command: string;
  let args: string[] = [];
  let cwd: string;

  if (isDev) {
    // In development, use Node.js to run the server
    command = 'node';
    args = [path.join(appPath, 'apps/server/dist/index.js')];
    cwd = appPath;
  } else {
    // In production, run the bundled server.exe (created by pkg)
    command = path.join(__dirname, 'server-dist', 'server.exe');
    args = [];
    cwd = path.join(__dirname, 'server-dist');
  }

  log(`Starting server: ${command}`);
  log(`Working directory: ${cwd}`);
  log(`NODE_ENV: ${isDev ? 'development' : 'production'}`);

  const { spawn } = await import('child_process');

  const serverProcess = spawn(command, args, {
    cwd: cwd,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: isDev ? 'development' : 'production',
      PORT: String(BACKEND_PORT),
    },
  });

  // Capture stdout/stderr for debugging
  if (serverProcess.stdout) {
    serverProcess.stdout.on('data', (data) => {
      log(`[Backend stdout] ${data.toString().trim()}`);
    });
  }

  if (serverProcess.stderr) {
    serverProcess.stderr.on('data', (data) => {
      log(`[Backend stderr] ${data.toString().trim()}`);
    });
  }

  serverProcess.on('error', (err) => {
    log(`Backend process error: ${err.message}`);
    log(`Stack: ${err.stack}`);
    if (!isQuitting && mainWindow) {
      dialog.showErrorBox('Backend Error', `Failed to start backend server:\n${err.message}`);
    }
  });

  serverProcess.on('exit', (code, signal) => {
    log(`Backend process exited with code ${code}, signal ${signal}`);
    if (!isQuitting && mainWindow) {
      dialog.showErrorBox('Backend Stopped', `Backend server stopped unexpectedly (exit code: ${code})`);
    }
  });

  // Wait for backend to be ready
  let attempts = 0;
  const maxAttempts = 30;

  while (attempts < maxAttempts) {
    try {
      await axios.get(BACKEND_HEALTH_CHECK, { timeout: 1000 });
      log('Backend server is ready');
      return;
    } catch (err) {
      attempts++;
      log(`Health check attempt ${attempts}/${maxAttempts} failed`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  log('Backend health check failed after 30 seconds');
  throw new Error('Backend server failed to start');
}

// Create the browser window
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Load the app
  if (isDev) {
    // In development, load from dev server
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // In production, load from built files
    // In ASAR packed app, __dirname is app.asar/dist
    // Web files are at app.asar/dist/web-dist (copied during build)
    const indexPath = path.join(__dirname, 'web-dist/index.html');
    log(`Loading web app from: ${indexPath}`);
    mainWindow.loadFile(indexPath).catch((err) => {
      log(`Failed to load web app: ${err}`);
      // Fallback to http
      mainWindow?.loadURL('http://localhost:3001');
    });
  }

  // Handle window events
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('minimize', () => {
    mainWindow?.hide();
  });
}

// Create tray icon and menu
function createTray(): void {
  // Create a simple 1x1 transparent image as fallback icon
  // electron will use default icon if not provided
  const { nativeImage } = require('electron');
  const emptyIcon = nativeImage.createEmpty();

  tray = new Tray(emptyIcon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    {
      label: 'Settings',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('navigate-to', '/settings');
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Toggle window on tray click
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  tray.setToolTip('DucKI Node - AI Agent');
}

// Handle app ready
app.on('ready', async () => {
  try {
    log('=== Application Starting ===');
    log(`isDev: ${isDev}`);
    log(`appPath: ${appPath}`);
    log(`Log file: ${logFile}`);

    await startBackend();
    createWindow();
    createTray();
    setupAutoStart();

    log('=== Application Started Successfully ===');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : '';
    log(`Failed to start application: ${errorMessage}`);
    log(`Stack: ${errorStack}`);

    dialog.showErrorBox(
      'Startup Error',
      `Failed to start DucKI application:\n\n${errorMessage}\n\nLog file: ${logFile}\n\nCheck the logs folder for details.`
    );
    app.quit();
  }
});

// Setup auto-start on Windows
function setupAutoStart(): void {
  const exePath = app.getPath('exe');
  app.setLoginItemSettings({
    openAtLogin: true,
    path: exePath,
  });
  log('Auto-start registered');
}

// Handle window all closed
app.on('window-all-closed', () => {
  // Don't quit on macOS when windows are closed
  if (process.platform !== 'darwin') {
    // On Windows, keep running in tray
  }
});

// Handle app activate (macOS)
app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Handle app quit
app.on('before-quit', () => {
  isQuitting = true;
  // Server process cleanup is handled by the OS when parent exits
});

// IPC Handlers
ipcMain.handle('navigate-to', (_event, path) => {
  if (mainWindow) {
    mainWindow.webContents.send('navigate', { path });
  }
});

// Set app as single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.show();
    }
  });
}
