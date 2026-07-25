import { useEffect, useRef, useState } from "react";

export type DuckyState = "idle" | "flying" | "landing" | "fallen";

interface DuckyMascotProps {
  /** true while the agent is actively working - the duck takes flight. */
  working: boolean;
  /** true when connected to server; false when connection is lost - duck falls. */
  connected?: boolean;
  /** pixel size of the (square) mascot. */
  size?: number;
  className?: string;
  title?: string;
}

const LANDING_DURATION_MS = 620;

/**
 * Small branded loading/status mascot: a duck that flies (flapping wings)
 * while the agent works, and lands + sits once it's done. Mounted once per
 * surface (chat header, sidebar, ...) so the land transition is visible -
 * it never unmounts on its own between working/idle.
 */
export function DuckyMascot({ working, connected = true, size = 32, className, title }: DuckyMascotProps) {
  const [state, setState] = useState<DuckyState>(working ? "flying" : "idle");
  const wasWorking = useRef(working);

  // Handle connection state
  useEffect(() => {
    if (!connected) {
      setState("fallen");
      return;
    }

    // If reconnected, recover to working or idle state
    if (working) {
      setState("flying");
    } else if (state === "fallen") {
      setState("idle");
    }
  }, [connected, working, state]);

  // Handle working state
  useEffect(() => {
    if (!connected) return; // Don't animate when disconnected

    if (working) {
      wasWorking.current = true;
      setState("flying");
      return;
    }

    if (!wasWorking.current) {
      setState("idle");
      return;
    }

    wasWorking.current = false;
    setState("landing");
    const timer = setTimeout(() => setState("idle"), LANDING_DURATION_MS);
    return () => clearTimeout(timer);
  }, [working, connected]);

  return (
    <div
      className={`ducky-mascot inline-flex items-center justify-center shrink-0 ${className ?? ""}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={title ?? (state === "fallen" ? "Verbindung verloren" : working ? "DucKI arbeitet" : "DucKI")}
      title={title ?? (state === "fallen" ? "Verbindung zum Server verloren" : undefined)}
      data-ducky-state={state}
    >
      <svg viewBox="0 0 64 64" width="100%" height="100%" className="ducky-body" data-ducky-state={state}>
        <ellipse className="ducky-shadow" cx="34" cy="55" rx="16" ry="3" data-ducky-state={state} />

        <g className="ducky-flightgroup" data-ducky-state={state}>
          {/* tail */}
          <path d="M14 40 Q6 38 8 46 Q12 47 17 43 Z" fill="#F2B705" />
          {/* body */}
          <ellipse cx="30" cy="42" rx="18" ry="14" fill="#FFCE31" />
          {/* wing */}
          <g className="ducky-wing" data-ducky-state={state}>
            <path d="M27 33 Q40 30 39 44 Q31 45 25 40 Z" fill="#F2B705" />
          </g>
          {/* head */}
          <circle cx="42" cy="24" r="11" fill="#FFCE31" />
          {/* beak */}
          <path d="M50 22 L60 25 L50 29 Z" fill="#FF8A1E" />
          {/* eye */}
          <g className="ducky-eye" data-ducky-state={state}>
            <circle cx="45" cy="21" r="2.2" fill="#22303C" />
          </g>
          {/* feet */}
          <g className="ducky-feet" data-ducky-state={state}>
            <path d="M24 55 L20 60 M24 55 L24 61 M24 55 L28 60" stroke="#FF8A1E" strokeWidth="2" strokeLinecap="round" fill="none" />
            <path d="M36 55 L32 60 M36 55 L36 61 M36 55 L40 60" stroke="#FF8A1E" strokeWidth="2" strokeLinecap="round" fill="none" />
          </g>
        </g>
      </svg>
    </div>
  );
}
