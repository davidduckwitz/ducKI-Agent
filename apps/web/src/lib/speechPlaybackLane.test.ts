import { afterEach, expect, it, vi } from "vitest";
import { requestSpeechLane, resetSpeechLaneForTests } from "./speechPlaybackLane";
import { isPlaybackActive, stopAllPlayback } from "./voicePlaybackRegistry";

afterEach(() => resetSpeechLaneForTests());

it("grants a free lane synchronously and queues later speakers in order", () => {
  const order: string[] = [];
  const a = requestSpeechLane(() => order.push("a"), vi.fn());
  const b = requestSpeechLane(() => order.push("b"), vi.fn());
  const c = requestSpeechLane(() => order.push("c"), vi.fn());
  expect(order).toEqual(["a"]);
  a.release();
  expect(order).toEqual(["a", "b"]);
  b.release();
  expect(order).toEqual(["a", "b", "c"]);
  c.release();
  expect(isPlaybackActive()).toBe(false);
});

it("lets a waiter leave without ever being granted", () => {
  const granted = vi.fn();
  const a = requestSpeechLane(vi.fn(), vi.fn());
  const b = requestSpeechLane(granted, vi.fn());
  b.release();
  a.release();
  expect(granted).not.toHaveBeenCalled();
});

it("stopAllPlayback reaches waiting speakers too", () => {
  const stopA = vi.fn();
  const stopB = vi.fn();
  const a = requestSpeechLane(vi.fn(), () => { stopA(); a.release(); });
  const b = requestSpeechLane(vi.fn(), () => { stopB(); b.release(); });
  stopAllPlayback();
  expect(stopA).toHaveBeenCalled();
  expect(stopB).toHaveBeenCalled();
  expect(isPlaybackActive()).toBe(false);
});
