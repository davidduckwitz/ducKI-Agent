import { forwardRef } from "react";
import { Mic, Square } from "lucide-react";

export type VoiceOrbState = "idle" | "listening" | "speaking" | "thinking";

interface VoiceOrbProps {
  state: VoiceOrbState;
  onClick: () => void;
  disabled?: boolean;
  title: string;
}

/**
 * Big, fixed, bottom-centered voice control - the primary way to talk to Erpel hands-free.
 * Concentric rings ripple outward like water; while `state === "listening"` the parent
 * updates `--level` on the forwarded ref directly (via requestAnimationFrame in voice.ts's
 * watcher) so the ripple visibly reacts to real mic loudness without routing 60fps updates
 * through React state.
 */
export const VoiceOrb = forwardRef<HTMLDivElement, VoiceOrbProps>(function VoiceOrb(
  { state, onClick, disabled, title },
  ref
) {
  return (
    <div className="voice-orb-wrap" data-state={state}>
      <div className="voice-orb-rings" ref={ref} aria-hidden="true">
        <span className="orb-ring r1" />
        <span className="orb-ring r2" />
        <span className="orb-ring r3" />
      </div>
      <button type="button" className="voice-orb" onClick={onClick} disabled={disabled} title={title} aria-label={title}>
        {state === "speaking" ? <Square /> : <Mic />}
      </button>
    </div>
  );
});
