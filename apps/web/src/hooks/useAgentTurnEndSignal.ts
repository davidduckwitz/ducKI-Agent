import { useEffect, useRef } from "react";
import { emitAgentTurnEnded } from "../lib/voiceConversationBus";

/**
 * Fires emitAgentTurnEnded() the moment `isPlaying` transitions from true to false, but only
 * while `enabled` - used to trigger the composer's "listen again" step for hands-free/
 * continuous conversation once the agent's spoken reply actually finishes.
 *
 * Known limitation: in sentence-by-sentence streaming mode, the underlying playback queue can
 * sit briefly empty between two sentences if the LLM is slow to produce the next one - that
 * momentary gap looks identical to "done speaking" here. Acceptable for now since this
 * codebase's agent typically streams in a few large chunks rather than many small ones with
 * long gaps between them (see agent.ts's onChunk usage).
 */
export function useAgentTurnEndSignal(isPlaying: boolean, enabled: boolean): void {
  const wasPlayingRef = useRef(false);

  useEffect(() => {
    if (isPlaying) {
      wasPlayingRef.current = true;
      return;
    }
    if (wasPlayingRef.current) {
      wasPlayingRef.current = false;
      if (enabled) emitAgentTurnEnded();
    }
  }, [isPlaying, enabled]);
}
