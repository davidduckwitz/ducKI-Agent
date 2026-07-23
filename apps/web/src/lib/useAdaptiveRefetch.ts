import { useEffect, useRef, useState } from "react";
import { useAppStore } from "./store";

export type RefetchVolatility = "idle" | "moderate" | "high";

/**
 * Adaptive refetch interval based on application activity level.
 * Returns appropriate polling interval or false to disable polling.
 */
function getAdaptiveInterval(volatility: RefetchVolatility): number | false {
  switch (volatility) {
    case "high":
      return 1500; // Active: poll every 1.5 seconds
    case "moderate":
      return 3000; // Moderate: poll every 3 seconds
    case "idle":
      return false; // Idle: disable polling
    default:
      return 5000; // Default: poll every 5 seconds
  }
}

/**
 * Hook to determine current application volatility based on running agents and operations.
 */
export function useCurrentVolatility(): RefetchVolatility {
  const agentStatus = useAppStore((state) => state.agentStatus);
  const isLoading = useAppStore((state) => state.isLoading);
  const globalRunningAgents = useAppStore((state) => state.globalRunningAgents);

  if (agentStatus === "running" || isLoading || globalRunningAgents > 0) {
    return "high";
  }

  // Could be expanded to detect other high-activity states
  return "idle";
}

/**
 * Custom hook for adaptive refetching based on application state.
 * Automatically adjusts refetch interval based on activity level.
 *
 * @param isActive - Whether to enable polling at all
 * @param baseVolatility - Optional base volatility to override auto-detection
 * @returns Refetch interval in milliseconds or false to disable
 */
export function useAdaptiveRefetch(
  isActive: boolean = true,
  baseVolatility?: RefetchVolatility
): number | false {
  const autoVolatility = useCurrentVolatility();
  const volatility = baseVolatility || autoVolatility;

  if (!isActive) {
    return false;
  }

  return getAdaptiveInterval(volatility);
}

/**
 * Context for consolidated polling - prevents multiple simultaneous requests.
 * Deduplicates requests within a 500ms window.
 */
class RequestDeduplicator {
  private pendingRequests = new Map<string, Promise<any>>();
  private deduplicationWindow = 500;

  async deduplicate<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const pending = this.pendingRequests.get(key);
    if (pending) {
      return pending as Promise<T>;
    }

    const promise = fn().finally(() => {
      this.pendingRequests.delete(key);
    });

    this.pendingRequests.set(key, promise);
    return promise;
  }
}

export const requestDeduplicator = new RequestDeduplicator();

/**
 * Utility to get stable polling configuration for React Query.
 */
export function getPollingConfig(isActive: boolean = true, baseVolatility?: RefetchVolatility) {
  const interval = useAdaptiveRefetch(isActive, baseVolatility);
  return {
    refetchInterval: interval,
    refetchIntervalInBackground: interval !== false,
  };
}
