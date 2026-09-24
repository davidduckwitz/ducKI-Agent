import { afterEach, expect, it, vi } from "vitest";
vi.mock("./backendUrl", () => ({ getAudioStreamWsUrl: () => "ws://localhost/audio" }));
import { createStreamingAudioPlayer } from "./streamingAudioPlayer";
import { isPlaybackActive, stopAllPlayback } from "./voicePlaybackRegistry";
import { interruptVoiceReply } from "./voiceCaptureBus";

afterEach(() => { interruptVoiceReply(); vi.unstubAllGlobals(); });

function setup() {
  const sources: Array<{ onended?: () => void }> = [];
  const close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("window", { AudioContext: class {
    currentTime = 0;
    destination = {};
    resume() { return Promise.resolve(); }
    close = close;
    createAnalyser() { return { fftSize: 1024, connect: vi.fn(), getByteTimeDomainData: vi.fn(), getByteFrequencyData: vi.fn() }; }
    createBuffer(_channels: number, size: number, rate: number) {
      return { duration: size / rate, getChannelData: () => new Float32Array(size) };
    }
    createBufferSource() {
      const source = { playbackRate: { value: 1 }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn() };
      sources.push(source);
      return source;
    }
    createGain() { return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; }
  } });
  class Socket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string | ArrayBuffer }) => void;
    send = vi.fn();
    close = vi.fn();
    constructor() { sockets.push(this); }
  }
  const sockets: Socket[] = [];
  vi.stubGlobal("WebSocket", Socket);
  const player = createStreamingAudioPlayer({});
  player.start();
  const socket = sockets[0]!;
  const open = () => { socket.readyState = 1; socket.onopen?.(); };
  const message = (data: object) => socket.onmessage?.({ data: JSON.stringify(data) });
  const audio = () => {
    message({ type: "meta", sampleRate: 24000 });
    socket.onmessage?.({ data: new Int16Array([1, 2, 3]).buffer });
  };
  return { player, socket, open, message, audio, sources, close };
}

it("drains queued speech before closing and reports playback to the orb", () => {
  const test = setup();
  test.player.pushText("Erster Satz.");
  test.player.pushText("Zweiter Satz.");
  test.player.end();
  test.open();
  expect(test.socket.send).toHaveBeenCalledTimes(1);
  test.audio();
  expect(isPlaybackActive()).toBe(true);
  test.message({ type: "done" });
  expect(test.socket.send).toHaveBeenCalledTimes(2);
  test.message({ type: "done" });
  expect(test.close).not.toHaveBeenCalled();
  test.sources[0]!.onended?.();
  expect(test.close).toHaveBeenCalledTimes(1);
  expect(isPlaybackActive()).toBe(false);
});

it("interrupts pending synthesis even before playback starts", () => {
  const test = setup();
  test.open();
  test.player.pushText("Noch nicht abgespielt.");
  interruptVoiceReply();
  test.audio();
  expect(test.sources).toHaveLength(0);
  expect(test.close).toHaveBeenCalledTimes(1);
});

it("stops streamed playback through the shared stop control", () => {
  const test = setup();
  test.open();
  test.audio();
  stopAllPlayback();
  expect(isPlaybackActive()).toBe(false);
  expect(test.close).toHaveBeenCalledTimes(1);
});
