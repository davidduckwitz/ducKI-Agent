import { useAppStore } from "./store";

export function useSocket() {
  return useAppStore((state) => state.socket);
}
