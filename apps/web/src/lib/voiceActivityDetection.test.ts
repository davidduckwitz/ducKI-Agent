import { afterEach, describe, expect, it, vi } from "vitest";
import { startVoiceActivityWatcher } from "./voiceActivityDetection";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  let now = 1000;
  let loud = false;
  let frame: () => void = () => {};
  const close = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { frame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("window", { AudioContext: class {
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: (data: Uint8Array) => data.fill(loud ? 150 : 128) }; }
    resume() { return Promise.resolve(); }
    close = close;
  } });
  const onSpeechStart = vi.fn();
  const onSilenceStop = vi.fn();
  const handle = startVoiceActivityWatcher({} as MediaStream, {
    silenceThreshold: 0.02, minSpeechMs: 200, silenceTimeoutMs: 500, onSpeechStart, onSilenceStop,
  });
  const advance = (speech: boolean, frames: number) => {
    loud = speech;
    for (let i = 0; i < frames; i++) { now += 50; frame(); }
  };
  return { advance, onSpeechStart, onSilenceStop, handle, close };
}

describe("voice activity interruption", () => {
  it("ignores silence and isolated clicks, then interrupts once for sustained speech", () => {
    const test = setup();
    test.advance(false, 20);
    test.advance(true, 1);
    test.advance(false, 20);
    test.advance(true, 1);
    test.advance(false, 20);
    expect(test.onSpeechStart).not.toHaveBeenCalled();
    expect(test.onSilenceStop).not.toHaveBeenCalled();
    test.advance(true, 6);
    expect(test.onSpeechStart).toHaveBeenCalledTimes(1);
    test.advance(false, 10);
    expect(test.onSilenceStop).toHaveBeenCalledTimes(1);
    expect(test.close).toHaveBeenCalledTimes(1);
  });

  it("releases the audio context and never sends after cancellation", () => {
    const test = setup();
    test.advance(true, 6);
    test.handle.stop();
    test.handle.stop();
    test.advance(false, 20);
    expect(test.onSilenceStop).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledTimes(1);
  });
});
