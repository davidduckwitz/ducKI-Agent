import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TOAST_DURATION, toastManager, type Toast } from "./toast";

/**
 * Regression coverage: the auto-dismiss never reached the screen. The timer removed the toast
 * from the manager's internal map, but the display renders its own list built from subscribe(),
 * so notifications piled up in the corner until each was clicked away by hand.
 */
describe("toastManager", () => {
  let shown: Toast[];
  let dismissed: string[];
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    shown = [];
    dismissed = [];
    const offShow = toastManager.subscribe((t) => shown.push(t));
    const offDismiss = toastManager.subscribeDismiss((id) => dismissed.push(id));
    unsubscribe = () => {
      offShow();
      offDismiss();
    };
  });

  afterEach(() => {
    unsubscribe();
    toastManager.clear();
    vi.useRealTimers();
  });

  it("announces the dismissal after 5 seconds, not just internally", () => {
    const id = toastManager.info("gespeichert");

    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION - 1);
    expect(dismissed, "still on screen just before the deadline").toEqual([]);

    vi.advanceTimersByTime(1);
    expect(dismissed).toEqual([id]);
    expect(toastManager.getAll()).toHaveLength(0);
  });

  it("gives every type the same 5 second lifetime", () => {
    toastManager.success("a");
    toastManager.error("b");
    toastManager.warning("c");
    toastManager.info("d");

    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION);
    expect(dismissed).toHaveLength(4);
  });

  it("keeps a toast with duration 0 until it is dismissed explicitly", () => {
    const id = toastManager.show("laeuft", "info", 0);

    vi.advanceTimersByTime(60_000);
    expect(dismissed).toEqual([]);

    toastManager.remove(id);
    expect(dismissed).toEqual([id]);
  });

  it("does not fire a stale timer for a manually closed toast", () => {
    const id = toastManager.success("weg damit");
    toastManager.remove(id);

    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION * 2);
    expect(dismissed, "exactly one dismissal, not a second from the expired timer").toEqual([id]);
  });

  it("respects an explicit duration override", () => {
    toastManager.error("langsam", 12_000);

    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION);
    expect(dismissed).toEqual([]);

    vi.advanceTimersByTime(7_000);
    expect(dismissed).toHaveLength(1);
  });
});
