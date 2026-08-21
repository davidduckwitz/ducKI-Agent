/**
 * Bitcoin puzzle solver core (ported from packages/agent/src/crypto/bitcoin-puzzle-solver.ts,
 * the previous core-app implementation, then extended with two extra search modes). Derives a
 * P2PKH address (BIP44 m/44'/0'/0'/0/0) from a 12-word BIP39 mnemonic and compares it against a
 * target address. Self-throttles with setImmediate every 100 iterations to yield the event loop.
 *
 * Three modes:
 * - "random": the original behavior, a fresh random mnemonic every attempt.
 * - "sequential": walks every possible 128-bit entropy value in strict numeric order via
 *   bip39.entropyToMnemonic (which computes the correct checksum word for each one) - a
 *   mathematically proper systematic search, resumable via a persisted counter. Replaces the
 *   old "every 5000th attempt, cycle through the wordlist" hack, which produced mnemonics with
 *   no valid checksum and wasn't genuinely exhaustive.
 * - "partial": the user supplies a phrase with 1-2 unknown words (__ or ?) and the solver
 *   exhaustively walks every substitution for just those positions - a finite, much smaller
 *   space than "search everything". Reports "exhausted" if it runs out without a match.
 */

import * as bip39 from "bip39";
import * as bitcoin from "bitcoinjs-lib";
import { BIP32Factory } from "bip32";
import * as tinysecp from "tiny-secp256k1";

const bip32 = BIP32Factory(tinysecp);

/** Upper bound for the buffer of not-yet-persisted attempts (memory-leak guard). */
const MAX_PENDING_ATTEMPTS = 50_000;

/** In-place big-endian increment of a 16-byte buffer (128-bit counter), wrapping at 2^128. */
function incrementBuffer16(buf) {
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] !== 0xff) { buf[i]++; return; }
    buf[i] = 0;
  }
}

export class BitcoinPuzzleSolver {
  constructor(wordList, config) {
    this.wordList = wordList;
    this.isRunning = false;
    this.isPaused = false;
    this.loopAlive = false;
    this.loopPromise = null;
    this.runStartedAt = Date.now();
    this.runStartCount = 0;
    this.triedCombinations = new Set();
    this.recentAttempts = [];
    this.pendingAttempts = [];
    this.eventListeners = [];
    this.onProgressCallback = undefined;
    this.phraseExistsCallback = undefined;
    /** Throttle: only log the 1st, 2nd, 4th, 8th, ... bad iteration, never a per-error flood. */
    this.badIterationCount = 0;

    this.mode = config.mode || "random";
    this.template = config.template;
    // "sequential": a 16-byte big-endian counter, entropyToMnemonic'd each step.
    this.sequentialCounter = config.sequentialCounterHex
      ? Buffer.from(config.sequentialCounterHex, "hex")
      : Buffer.alloc(16);
    // "partial": the full (usually large) set of concrete mnemonics for the blanks, walked by index.
    this.combinations = config.combinations || [];
    this.combinationIndex = config.combinationIndex || 0;

    this.state = {
      targetAddress: config.targetAddress,
      startMnemonic: config.startMnemonic,
      generatedCount: 0,
      startedAt: Date.now(),
      lastCheckAt: Date.now(),
      status: "idle",
      triedCombinationsCount: 0,
      currentCombinationMode: this.mode,
    };
  }

  on(listener) {
    this.eventListeners.push(listener);
  }

  off(listener) {
    this.eventListeners = this.eventListeners.filter((l) => l !== listener);
  }

  emit(event) {
    this.eventListeners.forEach((listener) => listener(event));
  }

  restoreState(savedState) {
    if (savedState.triedCombinationsCount !== undefined) this.state.triedCombinationsCount = savedState.triedCombinationsCount;
    if (savedState.generatedCount !== undefined) this.state.generatedCount = savedState.generatedCount;
    if (savedState.currentCombinationMode !== undefined) this.state.currentCombinationMode = savedState.currentCombinationMode;
    if (savedState.startedAt !== undefined) this.state.startedAt = savedState.startedAt;
    if (savedState.lastCheckAt !== undefined) this.state.lastCheckAt = savedState.lastCheckAt;
    // A puzzle saved while paused/running must come back paused - otherwise the UI shows "idle"
    // and the resume path thinks it's a fresh solver. Terminal states (completed/error/exhausted)
    // pass through unchanged.
    if (savedState.status !== undefined) this.state.status = savedState.status === "running" ? "paused" : savedState.status;
    if (savedState.foundAddress) this.state.foundAddress = savedState.foundAddress;
    if (savedState.foundMnemonic) {
      this.state.foundMnemonic = savedState.foundMnemonic;
      this.state.status = "completed";
    }
    if (savedState.errorMessage !== undefined) this.state.errorMessage = savedState.errorMessage;
    this.runStartCount = this.state.generatedCount;
  }

  /** Progress info specific to the finite "partial" mode - null for the other (unbounded) modes. */
  getCombinationProgress() {
    if (this.mode !== "partial") return null;
    return { index: this.combinationIndex, total: this.combinations.length };
  }

  getSequentialCounterHex() {
    return this.sequentialCounter.toString("hex");
  }

  getCombinationIndex() {
    return this.combinationIndex;
  }

  async start(onProgress) {
    if (onProgress) this.onProgressCallback = onProgress;

    // A second start() on the same solver would put a second batch loop on the same state
    // (double counters, double CSV writes). Just unpause instead.
    if (this.loopAlive && this.loopPromise) {
      this.isPaused = false;
      this.state.status = "running";
      return this.loopPromise;
    }

    this.isRunning = true;
    this.isPaused = false;
    this.loopAlive = true;
    this.state.status = "running";
    this.runStartedAt = Date.now();
    this.runStartCount = this.state.generatedCount;

    this.emit({ type: "started", timestamp: Date.now(), data: { targetAddress: this.state.targetAddress } });

    try {
      if (this.state.startMnemonic && !bip39.validateMnemonic(this.state.startMnemonic)) {
        throw new Error("Invalid starting mnemonic");
      }

      const runSolverIteration = () => {
        return new Promise((resolve) => {
          const finish = (state) => {
            this.loopAlive = false;
            this.loopPromise = null;
            resolve(state);
          };
          const processNextBatch = () => {
            if (!this.isRunning) {
              this.state.status = "idle";
              this.emit({ type: "stopped", timestamp: Date.now(), data: { reason: "manual_stop", attempts: this.state.generatedCount } });
              finish(this.state);
              return;
            }

            // Paused: don't keep spinning setImmediate - that busy-waits a full CPU core
            // while the puzzle is "paused".
            if (this.isPaused) {
              setTimeout(processNextBatch, 250);
              return;
            }

            const batchSize = 100;
            for (let batch = 0; batch < batchSize && this.isRunning && !this.isPaused; batch++) {
             try {
              let mnemonic;

              if (this.mode === "sequential") {
                mnemonic = bip39.entropyToMnemonic(this.sequentialCounter, this.wordList);
                incrementBuffer16(this.sequentialCounter);
              } else if (this.mode === "partial") {
                if (this.combinationIndex >= this.combinations.length) {
                  this.state.status = "exhausted";
                  this.isRunning = false;
                  this.emit({ type: "stopped", timestamp: Date.now(), data: { reason: "exhausted", attempts: this.state.generatedCount } });
                  this.onProgressCallback?.(this.state);
                  finish(this.state);
                  return;
                }
                mnemonic = this.combinations[this.combinationIndex];
                this.combinationIndex++;
              } else {
                mnemonic = bip39.generateMnemonic(128, undefined, this.wordList);
              }

              if (this.triedCombinations.has(mnemonic)) continue;

              if (this.phraseExistsCallback && this.phraseExistsCallback(mnemonic)) {
                this.triedCombinations.add(mnemonic);
                continue;
              }

              this.triedCombinations.add(mnemonic);
              this.state.triedCombinationsCount++;

              const address = this.generateAddressFromMnemonic(mnemonic);

              const attempt = { mnemonic, address };
              this.recentAttempts.push(attempt);
              if (this.recentAttempts.length > 50) this.recentAttempts.shift();
              this.pendingAttempts.push(attempt);
              if (this.pendingAttempts.length > MAX_PENDING_ATTEMPTS) this.pendingAttempts.shift();

              this.state.generatedCount++;
              this.state.lastCheckAt = Date.now();

              if (this.state.generatedCount % 500 === 0) {
                this.emit({
                  type: "attempt",
                  timestamp: Date.now(),
                  data: { attemptNumber: this.state.generatedCount, mode: this.mode, triedCombinationsCount: this.state.triedCombinationsCount },
                });
              }

              if (address === this.state.targetAddress) {
                this.state.status = "completed";
                this.state.foundAddress = address;
                this.state.foundMnemonic = mnemonic;
                this.isRunning = false;

                this.emit({
                  type: "found",
                  timestamp: Date.now(),
                  data: { address, mnemonic, attempts: this.state.generatedCount, elapsedMs: Date.now() - this.state.startedAt },
                });

                this.onProgressCallback?.(this.state);
                finish(this.state);
                return;
              }

              if (this.state.generatedCount % 100 === 0) {
                this.onProgressCallback?.(this.state);
                this.emit({
                  type: "progress",
                  timestamp: Date.now(),
                  data: { generatedCount: this.state.generatedCount, triedCombinationsCount: this.state.triedCombinationsCount, elapsedMs: Date.now() - this.state.startedAt },
                });
              }
             } catch (iterationError) {
              // A single bad iteration (e.g. a rare bip32/bitcoinjs-lib edge case out of
              // millions of mnemonics) must never take down the whole shared server process -
              // this loop runs in-process alongside everything else via the plugin's
              // moduleTool. Skip it and keep going instead of throwing out of setImmediate.
              // Logged with exponential backoff (1st, 2nd, 4th, 8th, ...) so a systematic
              // failure can't flood the terminal.
              this.badIterationCount++;
              if ((this.badIterationCount & (this.badIterationCount - 1)) === 0) {
                console.error(`[BitcoinPuzzleSolver] Skipping bad iteration (#${this.badIterationCount}): ${iterationError instanceof Error ? iterationError.message : String(iterationError)}`);
              }
             }
            }

            setImmediate(processNextBatch);
          };

          processNextBatch();
        });
      };

      return await runSolverIteration();
    } catch (error) {
      this.state.status = "error";
      this.state.errorMessage = error instanceof Error ? error.message : String(error);
      this.isRunning = false;
      this.loopAlive = false;
      this.loopPromise = null;
      this.emit({ type: "error", timestamp: Date.now(), data: { error: this.state.errorMessage } });
      return this.state;
    }
  }

  pause() {
    this.isPaused = true;
    this.state.status = "paused";
    this.onProgressCallback?.(this.state);
  }

  resume() {
    this.isPaused = false;
    this.isRunning = true;
    this.state.status = "running";
    // Reset the rate measurement, otherwise time spent paused dilutes the /sec figure.
    this.runStartedAt = Date.now();
    this.runStartCount = this.state.generatedCount;
  }

  isLoopAlive() {
    return this.loopAlive;
  }

  getRatePerSecond() {
    if (!this.loopAlive || this.isPaused) return 0;
    const elapsedMs = Date.now() - this.runStartedAt;
    if (elapsedMs <= 0) return 0;
    const delta = this.state.generatedCount - this.runStartCount;
    if (delta <= 0) return 0;
    return Math.round((delta / elapsedMs) * 1000);
  }

  getRunElapsedSeconds() {
    if (!this.loopAlive) return 0;
    return Math.round((Date.now() - this.runStartedAt) / 1000);
  }

  stop() {
    this.isRunning = false;
    this.isPaused = false;
    if (this.state.status !== "completed" && this.state.status !== "error" && this.state.status !== "exhausted") this.state.status = "idle";
  }

  getState() {
    return { ...this.state };
  }

  getRecentAttempts() {
    return [...this.recentAttempts];
  }

  setRecentAttempts(attempts) {
    this.recentAttempts = [...attempts.slice(-50)];
  }

  drainPendingAttempts() {
    const drained = this.pendingAttempts;
    this.pendingAttempts = [];
    return drained;
  }

  /**
   * Additive, never counter-reducing: a puzzle with 118,000 tried attempts must not report
   * "tried 50" again after every restart just because setTriedCombinations was called with a
   * short list.
   */
  setTriedCombinations(attempts) {
    for (const attempt of attempts) this.triedCombinations.add(attempt.mnemonic);
    this.state.triedCombinationsCount = Math.max(this.state.triedCombinationsCount, this.triedCombinations.size);
  }

  /** Raise the tried-counter without touching the dedupe set - used after a background index build. */
  raiseTriedCombinationsCount(count) {
    this.state.triedCombinationsCount = Math.max(this.state.triedCombinationsCount, count);
  }

  setPhraseExistsCallback(callback) {
    this.phraseExistsCallback = callback;
  }

  generateAddressFromMnemonic(mnemonic) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.fromSeed(seed);
    const child = root.derivePath("m/44'/0'/0'/0/0");
    if (!child.publicKey) throw new Error("Failed to derive public key");
    const address = bitcoin.payments.p2pkh({ pubkey: child.publicKey }).address;
    if (!address) throw new Error("Failed to generate address");
    return address;
  }
}
