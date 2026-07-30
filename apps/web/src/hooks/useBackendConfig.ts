import { useState, useEffect } from "react";

interface BackendConfig {
  type: "local" | "remote";
  url?: string;
  port?: number;
}

const STORAGE_KEY = "backend-config";
const DEFAULT_CONFIG: BackendConfig = { type: "local", port: 3001 };

export function useBackendConfig() {
  const [config, setConfig] = useState<BackendConfig>(DEFAULT_CONFIG);
  const [isLoading, setIsLoading] = useState(true);

  // Load config from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setConfig(JSON.parse(stored));
      }
    } catch (error) {
      console.error("Failed to load backend config:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const saveConfig = (newConfig: BackendConfig) => {
    setConfig(newConfig);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig));
  };

  const getBackendUrl = (): string => {
    // Check if running in Tauri or Electron (desktop apps need absolute URLs)
    const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI__;
    const isElectron = typeof window !== "undefined" && (window as any).electron;
    const isDesktop = isTauri || isElectron;

    if (config.type === "remote" && config.url) {
      return config.url.replace(/\/$/, "");
    }

    // Local: use absolute localhost URL on desktop, /api on web
    if (isDesktop) {
      const port = config.port || 3001;
      return `http://localhost:${port}`;
    }
    return "/api";
  };

  return { config, saveConfig, getBackendUrl, isLoading };
}
