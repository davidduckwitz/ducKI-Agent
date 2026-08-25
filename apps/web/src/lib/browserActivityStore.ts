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
  addActivity: (activity: Omit<BrowserActivity, "id">) => void;
  clearActivities: (sessionId?: string) => void;
}

export const useBrowserActivityStore = create<BrowserActivityState>()(
  persist(
    (set) => ({
      activities: [],
      addActivity: (activity) => set((state) => ({
        activities: [...state.activities, { ...activity, id: crypto.randomUUID() }].slice(-500),
      })),
      clearActivities: (sessionId) => set((state) => ({
        activities: sessionId ? state.activities.filter((item) => item.sessionId !== sessionId) : [],
      })),
    }),
    { name: "ducki.browser.timeline.v1" }
  )
);
