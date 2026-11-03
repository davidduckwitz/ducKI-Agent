import { describe, expect, it, vi, beforeEach } from "vitest";

const ffmpegState = vi.hoisted(() => ({ path: undefined as string | undefined, real: undefined as string | undefined }));

vi.mock("../src/media/binaries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/media/binaries.js")>();
  ffmpegState.real = await actual.findFfmpeg();
  return { ...actual, findFfmpeg: async () => ffmpegState.path };
});

import { transcodeAudio } from "../src/media/audio-transcode.js";

/** 16-bit PCM WAV with a constant sample value, so joins are easy to inspect. */
function makeWav(samples: number, opts: { sampleRate?: number; channels?: number; value?: number } = {}): Buffer {
  const sampleRate = opts.sampleRate ?? 24000;
  const channels = opts.channels ?? 1;
  const data = Buffer.alloc(samples * channels * 2);
  for (let i = 0; i < samples * channels; i++) data.writeInt16LE(opts.value ?? 1000, i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const wav = (samples: number, opts?: Parameters<typeof makeWav>[1]) => ({ audio: makeWav(samples, opts), mimeType: "audio/wav" });

describe("transcodeAudio without ffmpeg", () => {
  beforeEach(() => { ffmpegState.path = undefined; });

  it("passes a single clip in the target format through untouched", async () => {
    const clip = { audio: Buffer.from("ID3fake-mp3"), mimeType: "audio/mpeg" };
    const out = await transcodeAudio([clip], { format: "mp3" });
    expect(out.engine).toBe("passthrough");
    expect(out.audio).toBe(clip.audio);
    expect(out.mimeType).toBe("audio/mpeg");
  });

  it("joins same-format WAV clips with a silence gap in pure JS", async () => {
    const out = await transcodeAudio([wav(240), wav(480)], { format: "wav", gapMs: 10 });
    expect(out.engine).toBe("wav-concat");
    // 240 + 240 (10 ms gap at 24 kHz) + 480 samples, 2 bytes each
    expect(out.audio.readUInt32LE(40)).toBe((240 + 240 + 480) * 2);
    expect(out.audio.length).toBe(44 + (240 + 240 + 480) * 2);
    expect(out.audio.readInt16LE(44 + 300 * 2)).toBe(0); // inside the gap
    expect(out.audio.readInt16LE(44 + 600 * 2)).toBe(1000); // second clip
  });

  it("explains that ffmpeg is needed for MP3 from WAV and for mismatched WAVs", async () => {
    await expect(transcodeAudio([wav(100)], { format: "mp3" })).rejects.toThrow(/ffmpeg/);
    await expect(transcodeAudio([wav(100), wav(100, { sampleRate: 22050 })], { format: "wav" })).rejects.toThrow(/ffmpeg/);
  });

  it("rejects empty input", async () => {
    await expect(transcodeAudio([], { format: "wav" })).rejects.toThrow(/no audio clips/);
  });
});

describe.runIf(Boolean(ffmpegState.real))("transcodeAudio with ffmpeg", () => {
  beforeEach(() => { ffmpegState.path = ffmpegState.real; });

  it("joins mismatched WAV clips into one MP3", async () => {
    const out = await transcodeAudio([wav(24000), wav(22050, { sampleRate: 22050 })], { format: "mp3", bitrateKbps: 128, gapMs: 200 });
    expect(out.engine).toBe("ffmpeg");
    expect(out.mimeType).toBe("audio/mpeg");
    const isMp3 = out.audio.subarray(0, 3).toString("ascii") === "ID3" || (out.audio[0] === 0xff && (out.audio[1]! & 0xe0) === 0xe0);
    expect(isMp3).toBe(true);
  }, 30_000);

  it("resamples to the requested WAV rate and layout", async () => {
    const out = await transcodeAudio([wav(24000), wav(24000)], { format: "wav", sampleRate: 44100, channels: 2 });
    expect(out.engine).toBe("ffmpeg");
    expect(out.audio.readUInt16LE(22)).toBe(2);
    expect(out.audio.readUInt32LE(24)).toBe(44100);
  }, 30_000);
});

describe.runIf(Boolean(ffmpegState.real))("transcodeAudio effects", () => {
  beforeEach(() => { ffmpegState.path = ffmpegState.real; });

  it("applies tempo so the output gets shorter", async () => {
    const out = await transcodeAudio([wav(24000)], { format: "wav", tempo: 2 });
    expect(out.engine).toBe("ffmpeg");
    const dataBytes = out.audio.length - 44;
    expect(dataBytes).toBeLessThan(24000 * 2 * 0.6);
    expect(dataBytes).toBeGreaterThan(24000 * 2 * 0.4);
  }, 30_000);

  it("keeps the length when only the pitch changes", async () => {
    const out = await transcodeAudio([wav(24000)], { format: "wav", pitch: 1.5, sampleRate: 24000 });
    const dataBytes = out.audio.length - 44;
    expect(dataBytes).toBeGreaterThan(24000 * 2 * 0.9);
    expect(dataBytes).toBeLessThan(24000 * 2 * 1.1);
  }, 30_000);

  it("needs ffmpeg for effects even on WAV", async () => {
    ffmpegState.path = undefined;
    await expect(transcodeAudio([wav(100), wav(100)], { format: "wav", volume: 0.5 })).rejects.toThrow(/ffmpeg/);
  });
});
