import { useMemo } from "react";
import type { RenderedChatMessage } from "../chat/chatTypes";

type AttemptStatus = "running" | "verified" | "verify_failed" | "reflection" | "guardrail" | "aborted";

interface AttemptSummary {
  attempt: number;
  maxAttempts?: number;
  status: AttemptStatus;
}

const STATUS_STYLE: Record<AttemptStatus, string> = {
  running: "border-muted-foreground/40 bg-muted-foreground/10 text-muted-foreground animate-pulse",
  verified: "border-emerald-500/50 bg-emerald-500/15 text-emerald-200",
  verify_failed: "border-amber-500/50 bg-amber-500/15 text-amber-200",
  reflection: "border-orange-500/50 bg-orange-500/15 text-orange-200",
  guardrail: "border-amber-500/50 bg-amber-500/15 text-amber-200",
  aborted: "border-red-500/50 bg-red-500/15 text-red-200",
};

const STATUS_LABEL: Record<AttemptStatus, string> = {
  running: "läuft",
  verified: "verifiziert",
  verify_failed: "Verify fehlgeschlagen",
  reflection: "Strategiewechsel (Reflection)",
  guardrail: "Guardrail-Neustart",
  aborted: "abgebrochen (keine Konvergenz)",
};

/**
 * CodingAgent's OWN per-attempt "iteration" emit (coding-agent.ts) always carries both
 * `attempt` and `maxAttempts` together - the inner Agent's per-LLM-turn "iteration" emit
 * (agent.ts) carries neither. That difference is what lets this tell "a new coding attempt
 * started" apart from "the model took another turn within the same attempt" using only the
 * event data already flowing through, no new backend signal needed.
 */
function isAttemptBoundary(msg: RenderedChatMessage): boolean {
  return (
    msg.eventType === "iteration" &&
    typeof msg.eventData?.["attempt"] === "number" &&
    typeof msg.eventData?.["maxAttempts"] === "number"
  );
}

function classifyAttempt(bucket: RenderedChatMessage[]): AttemptStatus {
  let hasReflection = false;
  let hasGuardrail = false;
  let hasAborted = false;
  let hasVerifyFail = false;
  let hasVerified = false;
  for (const msg of bucket) {
    if (msg.eventType !== "decision") continue;
    const data = msg.eventData ?? {};
    const content = typeof msg.content === "string" ? msg.content : "";
    if (data["reflection"]) hasReflection = true;
    if (typeof data["abortedReason"] === "string") hasGuardrail = true;
    if (content.startsWith("Abgebrochen")) hasAborted = true;
    if (typeof data["error"] === "string" && data["error"].length > 0) hasVerifyFail = true;
    if (typeof data["verifyCommand"] === "string" && content.includes("erfolgreich")) hasVerified = true;
  }
  // Priority order, not emission order: a non-convergence abort is the most important thing to
  // show even though the "Verifikation fehlgeschlagen" decision for the same attempt fires
  // right alongside it; a reflection is more specific than the plain verify-failed it responds to.
  if (hasAborted) return "aborted";
  if (hasReflection) return "reflection";
  if (hasGuardrail) return "guardrail";
  if (hasVerifyFail) return "verify_failed";
  if (hasVerified) return "verified";
  return "running";
}

/**
 * At-a-glance overview of a coding run's attempts, so a long run (several retries, a
 * reflection-triggered strategy change, a guardrail stall) doesn't require scrolling the whole
 * activity feed to see where it stands. Purely derived from events already emitted/persisted -
 * no new backend data. Renders nothing for a single-attempt run, where it would only be noise.
 */
export function CodingAttemptTimeline({ events }: { events: RenderedChatMessage[] }) {
  const attempts = useMemo<AttemptSummary[]>(() => {
    const buckets: RenderedChatMessage[][] = [];
    for (const msg of events) {
      if (isAttemptBoundary(msg) || buckets.length === 0) buckets.push([msg]);
      else buckets[buckets.length - 1]!.push(msg);
    }
    return buckets.map((bucket, index) => {
      const boundary = bucket.find(isAttemptBoundary);
      const attempt = typeof boundary?.eventData?.["attempt"] === "number" ? (boundary.eventData["attempt"] as number) : index + 1;
      const maxAttempts = typeof boundary?.eventData?.["maxAttempts"] === "number" ? (boundary.eventData["maxAttempts"] as number) : undefined;
      return { attempt, maxAttempts, status: classifyAttempt(bucket) };
    });
  }, [events]);

  if (attempts.length <= 1) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-card/40 px-2 py-1.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Versuche</span>
      {attempts.map((a) => (
        <span
          key={a.attempt}
          title={`Versuch ${a.attempt}${a.maxAttempts ? `/${a.maxAttempts}` : ""}: ${STATUS_LABEL[a.status]}`}
          className={`flex h-5 min-w-5 items-center justify-center rounded border px-1 text-[10px] font-medium ${STATUS_STYLE[a.status]}`}
        >
          {a.attempt}
        </span>
      ))}
    </div>
  );
}
