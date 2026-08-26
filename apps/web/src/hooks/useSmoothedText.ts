import { useEffect, useRef, useState } from "react";

/**
 * Reveals `text` progressively instead of popping in whole chunks the instant they arrive,
 * so live-streamed text reads as "being typed" rather than jumping in uneven bursts (each
 * arriving chunk is a whole cleaned LLM response, not a token - see Agent.run()'s
 * marker-stripping, which buffers a full iteration before releasing any of it).
 *
 * Catches up rather than replaying at a fixed pace: the reveal speed scales with how far
 * behind the real text the display currently is, so a burst of several chunks arriving at
 * once (or the stream finishing) closes the gap within a couple of frames instead of adding
 * a fixed per-character delay on top of the real arrival time.
 *
 * A shrink or a change that isn't a plain append (new message replacing the old one, or a
 * reset to "") snaps immediately - only genuine incremental growth animates.
 */
export function useSmoothedText(text: string): string {
  const [displayed, setDisplayed] = useState(text);
  const displayedRef = useRef(text);
  const targetRef = useRef(text);
  const frameRef = useRef<number>();

  useEffect(() => {
    targetRef.current = text;

    const isAppend = text.length >= displayedRef.current.length && text.startsWith(displayedRef.current);
    if (!isAppend) {
      displayedRef.current = text;
      setDisplayed(text);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
      return;
    }

    if (frameRef.current) return; // already animating toward the (now-updated) target

    const tick = () => {
      const target = targetRef.current;
      const behind = target.length - displayedRef.current.length;
      if (behind <= 0) {
        frameRef.current = undefined;
        return;
      }
      // Reveal at least a few chars per frame so short gaps feel instant, and scale up for
      // long ones (e.g. the stream just finished and dumped a large tail) so catching up
      // never takes more than ~15 frames.
      const step = Math.max(2, Math.ceil(behind / 15));
      displayedRef.current = target.slice(0, displayedRef.current.length + step);
      setDisplayed(displayedRef.current);
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [text]);

  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
  }, []);

  return displayed;
}
