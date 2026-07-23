import { create } from "zustand";

interface CodingSessionState {
  selectedProject: string;
  selectedPath: string;
  setSelectedProject: (slug: string) => void;
  setSelectedPath: (path: string) => void;
}

export const useCodingSession = create<CodingSessionState>((set) => ({
  selectedProject: "",
  selectedPath: "",
  setSelectedProject: (slug) => set({ selectedProject: slug, selectedPath: "" }),
  setSelectedPath: (path) => set({ selectedPath: path }),
}));
