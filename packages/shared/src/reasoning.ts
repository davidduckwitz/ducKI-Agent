/** Browser-safe contract shared by the composers, HTTP/WebSocket routes and providers. */
export const REASONING_EFFORTS = ["off", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}
