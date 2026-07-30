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
    if (config.type === "remote" && config.url) {
      // Remove trailing slash if present
      return config.url.replace(/\/$/, "");
    }
    // Local: use /api for dev server, or localhost for production
    const isElectron = typeof window !== "undefined" && (window as any).electron;
    if (isElectron) {
      const port = config.port || 3001;
      return `http://localhost:${port}/api`;
    }
    return "/api";
  };

  return { config, saveConfig, getBackendUrl, isLoading };
}
