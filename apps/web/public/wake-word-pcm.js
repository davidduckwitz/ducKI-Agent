// AudioWorklet: resamples the mic signal to 16 kHz mono Int16 and posts fixed-size frames
// (1280 samples for openWakeWord, 512 for Porcupine). Loaded as a same-origin module file
// (see src/lib/wakeWord/index.ts) because the desktop CSP only allows 'self' scripts.
class WakeWordPcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameLength = options.processorOptions?.frameLength || 1280;
    this.ratio = sampleRate / 16000;
    this.position = 0;
    this.frame = new Int16Array(this.frameLength);
    this.filled = 0;
    this.previous = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    // Linear interpolation between neighbouring input samples; `position` carries the
    // fractional read offset across render quanta.
    while (this.position < channel.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const left = index === 0 ? this.previous : channel[index - 1];
      const right = channel[index];
      const sample = Math.max(-1, Math.min(1, left + (right - left) * fraction));
      this.frame[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (this.filled === this.frameLength) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Int16Array(this.frameLength);
        this.filled = 0;
      }
      this.position += this.ratio;
    }
    this.position -= channel.length;
    this.previous = channel[channel.length - 1];
    return true;
  }
}

registerProcessor("wake-word-pcm", WakeWordPcmProcessor);
