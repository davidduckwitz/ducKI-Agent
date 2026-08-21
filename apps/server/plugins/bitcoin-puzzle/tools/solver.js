/**
 * Bitcoin puzzle solver core (ported near-verbatim from packages/agent/src/crypto/bitcoin-puzzle-solver.ts,
 * the previous core-app implementation). Brute-forces random/ordered 12-word BIP39 mnemonics,
 * derives a P2PKH address (BIP44 m/44'/0'/0'/0/0) and compares against a target address.
 * Self-throttles with setImmediate every 100 iterations to yield the event loop - this already
 * ran synchronously in the main process before (no worker_threads/child_process), so moving it
 * into a moduleTool changes nothing about its CPU behavior.
 */

import * as bip39 from "bip39";
import * as bitcoin from "bitcoinjs-lib";
import { BIP32Factory } from "bip32";
import * as tinysecp from "tiny-secp256k1";

const bip32 = BIP32Factory(tinysecp);

/** Upper bound for the buffer of not-yet-persisted attempts (memory-leak guard). */
const MAX_PENDING_ATTEMPTS = 50_000;

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

    this.state = {
      targetAddress: config.targetAddress,
      startMnemonic: config.startMnemonic,
      generatedCount: 0,
      startedAt: Date.now(),
      lastCheckAt: Date.now(),
      status: "idle",
      triedCombinationsCount: 0,
      currentCombinationMode: "random",
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
    // A puzzle saved while paused must come back paused - otherwise the UI shows "idle" and
    // the resume path thinks it's a fresh solver.
    if (savedState.status !== undefined) this.state.status = savedState.status === "running" ? "paused" : savedState.status;
    if (savedState.foundAddress) this.state.foundAddress = savedState.foundAddress;
    if (savedState.foundMnemonic) {
      this.state.foundMnemonic = savedState.foundMnemonic;
      this.state.status = "completed";
    }
    if (savedState.errorMessage !== undefined) this.state.errorMessage = savedState.errorMessage;
    this.runStartCount = this.state.generatedCount;
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

              if (this.state.generatedCount % 5000 === 0 && this.state.generatedCount > 0) {
                this.state.currentCombinationMode = "ordered";
                mnemonic = this.generateOrderedMnemonic();
                // The ordered phrase is deterministic; if it's a duplicate and we just
                // `continue`, it comes back next iteration unchanged (infinite loop).
                if (this.triedCombinations.has(mnemonic)) {
                  this.state.currentCombinationMode = "random";
                  mnemonic = bip39.generateMnemonic(128, undefined, this.wordList);
                }
              } else {
                this.state.currentCombinationMode = "random";
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
                  data: { attemptNumber: this.state.generatedCount, mode: this.state.currentCombinationMode, triedCombinationsCount: this.state.triedCombinationsCount },
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
              console.error(`[BitcoinPuzzleSolver] Skipping bad iteration: ${iterationError instanceof Error ? iterationError.message : String(iterationError)}`);
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

  generateOrderedMnemonic() {
    const wordCount = 12;
    const words = [];
    if (this.wordList.length === 0) return bip39.generateMnemonic(128, undefined, this.wordList);
    for (let i = 0; i < wordCount; i++) {
      const index = (this.triedCombinations.size + i) % this.wordList.length;
      const word = this.wordList[index];
      if (word) words.push(word);
    }
    return words.length === wordCount ? words.join(" ") : bip39.generateMnemonic(128, undefined, this.wordList);
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
    if (this.state.status !== "completed" && this.state.status !== "error") this.state.status = "idle";
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
