import { useState } from "react";
import {
  getApiBaseUrl,
  getHealthUrl,
  readBackendConfig,
  writeBackendConfig,
  type BackendConfig,
} from "../lib/backendUrl";

export type { BackendConfig };

/**
 * Thin React wrapper around the shared backend-URL resolution in lib/backendUrl.ts.
 *
 * The config is read synchronously in the state initializer: reading it in an effect
 * meant the first render always used the default, so a configured remote backend was
 * briefly ignored on every page load. It also duplicated the URL logic that api.ts had
 * its own copy of, and the two could disagree.
 */
export function useBackendConfig() {
  const [config, setConfig] = useState<BackendConfig>(() => readBackendConfig());

  const saveConfig = (newConfig: BackendConfig) => {
    setConfig(newConfig);
    writeBackendConfig(newConfig);
  };

  return {
    config,
    saveConfig,
    getBackendUrl: () => getApiBaseUrl(config),
    getHealthUrl: () => getHealthUrl(config),
    /** Kept so callers that guarded on the old async read keep compiling. */
    isLoading: false,
  };
}
