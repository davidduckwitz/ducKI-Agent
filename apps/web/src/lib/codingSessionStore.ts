import { create } from "zustand";
import { persist } from "zustand/middleware";

/** One-shot commands fired from the sidebar's "Neu" menu into the coding views. */
export type CodingCommandAction = "idle" | "new-file" | "new-project" | "upload";

interface CodingSessionState {
  selectedProject: string;
  /** Files open as editor tabs, in tab order. */
  openPaths: string[];
  /** The tab currently shown in the editor. */
  selectedPath: string;
  /** Unsaved editor content per path - survives tab switches and reloads. */
  drafts: Record<string, string>;
  command: { nonce: number; action: CodingCommandAction };

  setSelectedProject: (slug: string) => void;
  setSelectedPath: (path: string) => void;
  openFile: (path: string) => void;
  closeFile: (path: string) => void;
  closeAllFiles: () => void;
  setDraft: (path: string, content: string) => void;
  clearDraft: (path: string) => void;
  renamePath: (fromPath: string, toPath: string) => void;
  runCommand: (action: CodingCommandAction) => void;
}

export const useCodingSession = create<CodingSessionState>()(
  persist(
    (set, get) => ({
      selectedProject: "",
      openPaths: [],
      selectedPath: "",
      drafts: {},
      command: { nonce: 0, action: "idle" },

      // Switching projects invalidates every open path - they belong to the old tree.
      setSelectedProject: (slug) =>
        set((s) =>
          s.selectedProject === slug ? s : { selectedProject: slug, selectedPath: "", openPaths: [], drafts: {} }
        ),

      setSelectedPath: (path) => {
        if (!path) {
          set({ selectedPath: "" });
          return;
        }
        get().openFile(path);
      },

      openFile: (path) =>
        set((s) => ({
          selectedPath: path,
          openPaths: s.openPaths.includes(path) ? s.openPaths : [...s.openPaths, path],
        })),

      closeFile: (path) =>
        set((s) => {
          const index = s.openPaths.indexOf(path);
          const openPaths = s.openPaths.filter((entry) => entry !== path);
          const drafts = { ...s.drafts };
          delete drafts[path];
          // Focus the neighbour, the way editors do - not "nothing".
          const selectedPath =
            s.selectedPath === path ? (openPaths[Math.min(index, openPaths.length - 1)] ?? "") : s.selectedPath;
          return { openPaths, drafts, selectedPath };
        }),

      closeAllFiles: () => set({ openPaths: [], selectedPath: "", drafts: {} }),

      setDraft: (path, content) => set((s) => ({ drafts: { ...s.drafts, [path]: content } })),

      clearDraft: (path) =>
        set((s) => {
          if (!(path in s.drafts)) return s;
          const drafts = { ...s.drafts };
          delete drafts[path];
          return { drafts };
        }),

      renamePath: (fromPath, toPath) =>
        set((s) => {
          const drafts = { ...s.drafts };
          if (fromPath in drafts) {
            drafts[toPath] = drafts[fromPath] as string;
            delete drafts[fromPath];
          }
          return {
            openPaths: s.openPaths.map((entry) => (entry === fromPath ? toPath : entry)),
            selectedPath: s.selectedPath === fromPath ? toPath : s.selectedPath,
            drafts,
          };
        }),

      runCommand: (action) => set((s) => ({ command: { nonce: s.command.nonce + 1, action } })),
    }),
    {
      name: "ducki.coding.session.v1",
      version: 1,
      // Only the cheap, stable bits are persisted. `drafts` is deliberately excluded:
      // it changes on every keystroke (one localStorage write each) and restoring it
      // after a reload would silently shadow whatever the agent wrote to disk since.
      // `command` must not be replayed on reload either.
      partialize: (state) =>
        ({
          selectedProject: state.selectedProject,
          selectedPath: state.selectedPath,
          openPaths: state.openPaths,
        }) as CodingSessionState,
    }
  )
);
