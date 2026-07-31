import { useEffect } from "react";
import {
  onlineManager,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useConnectionStore } from "./connectionStore";
import { useCurrentVolatility, type RefetchVolatility } from "./useAdaptiveRefetch";

/**
 * Drives React Query's own online/offline state from our handshake.
 *
 * This is the global half of the gate: while "offline", React Query pauses every query
 * and mutation - no interval refetches, no retries - and resumes them once the
 * connection is back. Without it we would have had to touch each of the ~20 components
 * that own a polling timer, and any new one would silently miss the gate.
 *
 * Call once, at the app root.
 */
export function startConnectionGate(): () => void {
  const apply = (status: string) => onlineManager.setOnline(status === "ready");
  apply(useConnectionStore.getState().status);
  return useConnectionStore.subscribe((state) => apply(state.status));
}

/**
 * Every recurring request goes through here.
 *
 * Two things it guarantees that plain `useQuery` did not:
 *  - nothing runs before the handshake completed, and everything stops the moment the
 *    connection is lost (previously ~20 independent timers kept firing into the void,
 *    each amplified by React Query's retries);
 *  - polling intervals follow the app's actual activity via `useCurrentVolatility`
 *    instead of hard-coded numbers.
 */
export interface ServerQueryOptions<TData> extends Omit<UseQueryOptions<TData, Error, TData, QueryKey>, "refetchInterval"> {
  /**
   * How volatile this data is. "idle" means no polling at all - the default, because
   * most data now arrives via socket push or is invalidated explicitly.
   */
  volatility?: RefetchVolatility;
  /** Escape hatch for a fixed interval when the data really does need one. */
  refetchInterval?: number | false;
}

export function useServerQuery<TData>(options: ServerQueryOptions<TData>): UseQueryResult<TData, Error> {
  const status = useConnectionStore((s) => s.status);
  const ready = status === "ready";
  const autoVolatility = useCurrentVolatility();

  const { volatility, refetchInterval, enabled, retry, ...rest } = options;

  const interval = (() => {
    if (refetchInterval !== undefined) return ready ? refetchInterval : false;
    if (!ready) return false;
    const effective = volatility ?? autoVolatility;
    if (effective === "high") return 1500;
    if (effective === "moderate") return 5000;
    return false as const;
  })();

  return useQuery<TData, Error, TData, QueryKey>({
    ...rest,
    enabled: ready && (enabled ?? true),
    // Retrying against a backend we know is gone only multiplies the noise.
    retry: ready ? (retry ?? 1) : false,
    refetchInterval: interval,
    refetchOnWindowFocus: ready,
  });
}

/**
 * Invalidates queries when the server announces a settings change, so the four
 * components that used to poll `settings.list()` every 5 seconds can share one cached
 * query with `staleTime: Infinity`.
 */
export function useSettingsChangeListener(): void {
  const qc = useQueryClient();

  useEffect(() => {
    const onChange = () => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
    };
    window.addEventListener("ducki:settings-changed", onChange);
    return () => window.removeEventListener("ducki:settings-changed", onChange);
  }, [qc]);
}
