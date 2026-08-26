import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface BrowserActivity {
  id: string;
  sessionId: string;
  action: string;
  actor: "user" | "agent";
  params: Record<string, unknown>;
  success: boolean;
  error?: string;
  timestamp: string;
}

interface BrowserActivityState {
  activities: BrowserActivity[];
  /** Off by default would silently hide agent actions from the timeline too, so this
   *  defaults to true - the toggle in the UI is an explicit opt-out, not opt-in. */
  recordingEnabled: boolean;
  addActivity: (activity: Omit<BrowserActivity, "id">) => void;
  clearActivities: (sessionId?: string) => void;
  setRecordingEnabled: (enabled: boolean) => void;
}

export const useBrowserActivityStore = create<BrowserActivityState>()(
  persist(
    (set, get) => ({
      activities: [],
      recordingEnabled: true,
      addActivity: (activity) => {
        if (!get().recordingEnabled) return;
        set((state) => ({
          activities: [...state.activities, { ...activity, id: crypto.randomUUID() }].slice(-500),
        }));
      },
      clearActivities: (sessionId) => set((state) => ({
        activities: sessionId ? state.activities.filter((item) => item.sessionId !== sessionId) : [],
      })),
      setRecordingEnabled: (recordingEnabled) => set({ recordingEnabled }),
    }),
    { name: "ducki.browser.timeline.v1" }
  )
);
