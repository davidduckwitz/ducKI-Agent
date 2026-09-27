/**
 * Bridge to the Tauri desktop shell (apps/tauri-desktop). The shell enables `withGlobalTauri`,
 * so the IPC entry point is `window.__TAURI__.core.invoke` - no @tauri-apps/api dependency is
 * needed in the web bundle, and in a plain browser every helper here degrades to a no-op.
 */

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
}

export interface DesktopPreferencesPatch {
  autostart?: boolean;
  closeToTray?: boolean;
  showSplash?: boolean;
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
