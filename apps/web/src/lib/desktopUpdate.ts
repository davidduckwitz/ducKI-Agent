import { useSyncExternalStore } from "react";
import {
  checkDesktopUpdate,
  installDesktopUpdate,
  onDesktopUpdateProgress,
  type DesktopUpdateInfo,
  type DesktopUpdateProgress,
} from "./desktop";

/**
 * Shared state of the desktop self-update, used by the global banner (which also runs the
 * schedule) and the settings overview card. Lives outside React so both see the same result.
 */
export interface DesktopUpdateState {
  checking: boolean;
  /** Newer version found, null when up to date or not checked yet. */
  update: DesktopUpdateInfo | null;
  /** Hidden by the user via the banner's X; the settings card still shows it. */
  dismissed: boolean;
  installing: boolean;
  progress: DesktopUpdateProgress | null;
  lastChecked: number | null;
  /** Error from the last manual check or install. */
  error: string | null;
  /** The last successful check found nothing newer. */
  upToDate: boolean;
}

const LAST_CHECK_KEY = "ducki.desktopUpdate.lastCheck";

function readLastChecked(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_CHECK_KEY);
    return raw ? Number(raw) || null : null;
  } catch {
    return null;
  }
}

let state: DesktopUpdateState = {
  checking: false,
  update: null,
  dismissed: false,
  installing: false,
  progress: null,
  lastChecked: readLastChecked(),
  error: null,
  upToDate: false,
};
const listeners = new Set<() => void>();

function set(patch: Partial<DesktopUpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useDesktopUpdate(): DesktopUpdateState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state
  );
}

export function getLastChecked(): number | null {
  return state.lastChecked;
}

export function dismissDesktopUpdate() {
  set({ dismissed: true });
}

/** `manual` surfaces errors; scheduled checks stay silent when the server is unreachable. */
export async function runDesktopUpdateCheck(manual: boolean): Promise<void> {
  if (state.checking || state.installing) return;
  set({ checking: true, error: manual ? null : state.error });
  const now = Date.now();
  try {
    const found = await checkDesktopUpdate();
    try {
      window.localStorage.setItem(LAST_CHECK_KEY, String(now));
    } catch {
      /* the schedule then simply starts over after a restart */
    }
    const isNew = found !== null && found.version !== state.update?.version;
    set({
      checking: false,
      update: found,
      dismissed: isNew ? false : state.dismissed,
      lastChecked: now,
      error: null,
      upToDate: found === null,
    });
  } catch (error) {
    // Failed scheduled checks do not advance the schedule's clock beyond one period anyway.
    set({ checking: false, lastChecked: now, error: manual ? String(error) : state.error });
  }
}

export async function installDesktopUpdateNow(): Promise<void> {
  if (state.installing || !state.update) return;
  set({ installing: true, progress: null, error: null });
  const off = onDesktopUpdateProgress((progress) => set({ progress }));
  try {
    await installDesktopUpdate();
  } catch (error) {
    set({ installing: false, error: String(error) });
  } finally {
    off();
  }
}
