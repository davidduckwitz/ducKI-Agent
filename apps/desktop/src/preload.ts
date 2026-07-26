import { contextBridge, ipcRenderer } from 'electron';

// Expose secure IPC to renderer process
contextBridge.exposeInMainWorld('electron', {
  navigateTo: (path: string) => ipcRenderer.invoke('navigate-to', path),
  onNavigate: (callback: (data: { path: string }) => void) => {
    ipcRenderer.on('navigate', (_event, data) => callback(data));
  },
});
