/**
 * Bridge to the Tauri desktop shell (apps/tauri-desktop). The shell enables `withGlobalTauri`,
 * so the IPC entry point is `window.__TAURI__.core.invoke` - no @tauri-apps/api dependency is
 * needed in the web bundle, and in a plain browser every helper here degrades to a no-op.
 */

export type UpdateInterval = "off" | "hourly" | "daily";

export interface DesktopInfo {
  version: string;
  port: number;
  backendUrl: string;
  dataDir: string;
  logsDir: string;
  workspaceDir: string;
  pluginsDir: string;
  skillsDir: string;
  autostart: boolean;
  closeToTray: boolean;
  showSplash: boolean;
  autoUpdateCheck: boolean;
  updateInterval: UpdateInterval;
}

export interface DesktopPreferencesPatch {
  autostart?: boolean;
  closeToTray?: boolean;
  showSplash?: boolean;
  autoUpdateCheck?: boolean;
  updateInterval?: UpdateInterval;
}

export type DesktopFolder = "workspace" | "data" | "logs" | "plugins" | "skills";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function tauriInvoke(): Invoke | null {
  if (typeof window === "undefined") return null;
  const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__;
  return tauri?.core?.invoke ?? null;
}

/** True only inside the Tauri desktop shell (not Electron, not a browser). */
export function isTauriDesktop(): boolean {
  return tauriInvoke() !== null;
}

export async function getDesktopInfo(): Promise<DesktopInfo | null> {
  const invoke = tauriInvoke();
  return invoke ? invoke<DesktopInfo>("desktop_info") : null;
}

export async function setDesktopPreferences(patch: DesktopPreferencesPatch): Promise<DesktopInfo | null> {
  const invoke = tauriInvoke();
  return invoke ? invoke<DesktopInfo>("desktop_set_preferences", { patch }) : null;
}

export async function openDesktopFolder(kind: DesktopFolder): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) await invoke("desktop_open_folder", { kind });
}

export interface DesktopUpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
}

export interface DesktopUpdateProgress {
  downloaded: number;
  total: number | null;
}

/** Asks the update server for a newer desktop version. Resolves to null if up to date. */
export async function checkDesktopUpdate(): Promise<DesktopUpdateInfo | null> {
  const invoke = tauriInvoke();
  return invoke ? invoke<DesktopUpdateInfo | null>("check_update") : null;
}

/** Downloads and installs the update; the desktop shell restarts the app. Only returns on failure. */
export async function installDesktopUpdate(): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) await invoke("install_update");
}

/** Subscribes to download progress. Returns an unsubscribe function. */
export function onDesktopUpdateProgress(handler: (p: DesktopUpdateProgress) => void): () => void {
  const listen = (
    window as unknown as {
      __TAURI__?: { event?: { listen?: (name: string, cb: (e: { payload: DesktopUpdateProgress }) => void) => Promise<() => void> } };
    }
  ).__TAURI__?.event?.listen;
  if (!listen) return () => undefined;
  const pending = listen("update-progress", (e) => handler(e.payload));
  return () => {
    void pending.then((unlisten) => unlisten());
  };
}
