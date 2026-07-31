import * as bip39 from "bip39";
import * as bitcoin from "bitcoinjs-lib";
import { BIP32Factory } from "bip32";
import * as tinysecp from "tiny-secp256k1";

const bip32 = BIP32Factory(tinysecp);

export interface SolverState {
  targetAddress: string;
  startMnemonic?: string;
  generatedCount: number;
  startedAt: number;
  lastCheckAt: number;
  foundAddress?: string;
  foundMnemonic?: string;
  status: "idle" | "running" | "paused" | "completed" | "error";
  errorMessage?: string;
  progressPercentage?: number;
  triedCombinationsCount: number;
  currentCombinationMode: "random" | "ordered" | "exhaustive";
}

export interface SolverEvent {
  type: "attempt" | "found" | "progress" | "error" | "started" | "stopped";
  timestamp: number;
  data: Record<string, unknown>;
}

export interface SolverConfig {
  targetAddress: string;
  startMnemonic?: string;
  batchSize?: number;
}

type EventListener = (event: SolverEvent) => void;

export interface AttemptRecord {
  mnemonic: string;
  address: string;
}

class BitcoinPuzzleSolver {
  private state: SolverState;
  private isRunning = false;
  private isPaused = false;
  private wordList: string[];
  private triedCombinations: Set<string> = new Set(); // Intern nur Set für Duplikat-Check
  private recentAttempts: AttemptRecord[] = []; // Letzte 50 verarbeiteten Phrasen mit Adressen
  private eventListeners: EventListener[] = [];
  private onProgressCallback?: (state: SolverState) => void; // Callback für Speicherung
  private phraseExistsCallback?: (phrase: string) => boolean; // Callback um externe Phrase-Datenbank zu prüfen

  constructor(
    wordList: string[],
    config: SolverConfig
  ) {
    this.wordList = wordList;
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

  /**
   * Event Listener registrieren
   */
  on(listener: EventListener): void {
    this.eventListeners.push(listener);
  }

  /**
   * Event Listener entfernen
   */
  off(listener: EventListener): void {
    this.eventListeners = this.eventListeners.filter((l) => l !== listener);
  }

  /**
   * Event emittieren
   */
  private emit(event: SolverEvent): void {
    this.eventListeners.forEach((listener) => listener(event));
  }

  /**
   * Stelle einen gespeicherten State wieder her
   */
  restoreState(savedState: Partial<SolverState>): void {
    if (savedState.triedCombinationsCount !== undefined) {
      this.state.triedCombinationsCount = savedState.triedCombinationsCount;
    }
    if (savedState.generatedCount !== undefined) {
      this.state.generatedCount = savedState.generatedCount;
    }
    if (savedState.currentCombinationMode !== undefined) {
      this.state.currentCombinationMode = savedState.currentCombinationMode;
    }
    if (savedState.startedAt !== undefined) {
      this.state.startedAt = savedState.startedAt;
    }
    if (savedState.lastCheckAt !== undefined) {
      this.state.lastCheckAt = savedState.lastCheckAt;
    }
    if (savedState.foundMnemonic !== undefined && savedState.foundMnemonic) {
      this.state.foundMnemonic = savedState.foundMnemonic;
      this.state.status = "completed";
    }
    if (savedState.errorMessage !== undefined) {
      this.state.errorMessage = savedState.errorMessage;
    }
  }

  /**
   * Starte den Solver-Prozess mit verschiedenen Kombinationsstrategien
   */
  async start(onProgress?: (state: SolverState) => void): Promise<SolverState> {
    this.onProgressCallback = onProgress; // Speichere Callback für spätere Nutzung (z.B. beim Pause)
    this.isRunning = true;
    this.state.status = "running";

    this.emit({
      type: "started",
      timestamp: Date.now(),
      data: { targetAddress: this.state.targetAddress },
    });

    try {
      // Wenn wir eine Start-Phrase haben, verifiziere sie
      if (this.state.startMnemonic) {
        if (!bip39.validateMnemonic(this.state.startMnemonic)) {
          throw new Error("Invalid starting mnemonic");
        }
      }

      // Starte den Lösungsprozess - mit Event-Loop-Freigabe
      const runSolverIteration = (): Promise<SolverState> => {
        return new Promise((resolve) => {
          const processNextBatch = () => {
            if (!this.isRunning) {
              this.state.status = "idle";
              this.emit({
                type: "stopped",
                timestamp: Date.now(),
                data: { reason: "manual_stop", attempts: this.state.generatedCount },
              });
              resolve(this.state);
              return;
            }

            // Wenn pausiert: warte aktiv ohne setTimeout (verhindert dass Loop "steckenbleibt")
            // Nutze busy-wait aber mit setImmediate für andere Tasks
            if (this.isPaused) {
              setImmediate(processNextBatch);
              return;
            }

            // Verarbeite 100 Iterationen pro Batch um Event-Loop freizugeben
            const batchSize = 100;
            for (let batch = 0; batch < batchSize && this.isRunning && !this.isPaused; batch++) {
              // Generiere Mnemonic basierend auf Strategie
              let mnemonic: string;

              if (this.state.generatedCount % 5000 === 0 && this.state.generatedCount > 0) {
                this.state.currentCombinationMode = "ordered";
                mnemonic = this.generateOrderedMnemonic();
              } else {
                this.state.currentCombinationMode = "random";
                mnemonic = bip39.generateMnemonic(128, undefined, this.wordList);
              }

              // Überprüfe auf Duplikate (interne Datenbank - schnell)
              if (this.triedCombinations.has(mnemonic)) {
                if (this.state.generatedCount % 10000 === 0) {
                  console.log(`[BitcoinPuzzleSolver] Duplicate detected (internal): ${mnemonic.substring(0, 20)}... at iteration ${this.state.generatedCount}`);
                }
                continue;
              }

              // Überprüfe externe Datenbank (CSV Search API - nur aktuelle Puzzle CSV)
              // Mit nur einer Puzzle CSV ist das günstig genug um häufiger zu prüfen
              let isExternalDuplicate = false;
              if (this.phraseExistsCallback && this.state.generatedCount % 100 === 0) {
                isExternalDuplicate = this.phraseExistsCallback(mnemonic);
                if (isExternalDuplicate && this.state.generatedCount % 10000 === 0) {
                  console.log(`[BitcoinPuzzleSolver] External duplicate detected at iteration ${this.state.generatedCount}`);
                }
                if (isExternalDuplicate) {
                  continue;
                }
              }

              this.triedCombinations.add(mnemonic);
              this.state.triedCombinationsCount = this.triedCombinations.size;

              if (this.state.generatedCount % 10000 === 0) {
                console.log(`[BitcoinPuzzleSolver] Progress: ${this.state.generatedCount} generated, ${this.state.triedCombinationsCount} tried`);
              }

              // Generiere Bitcoin-Adresse
              const address = this.generateAddressFromMnemonic(mnemonic);

              // Speichere in recentAttempts (letzte 50)
              this.recentAttempts.push({ mnemonic, address });
              if (this.recentAttempts.length > 50) {
                this.recentAttempts.shift();
              }

              this.state.generatedCount++;
              this.state.lastCheckAt = Date.now();

              // Emittiere attempt Event
              if (this.state.generatedCount % 500 === 0) {
                this.emit({
                  type: "attempt",
                  timestamp: Date.now(),
                  data: {
                    attemptNumber: this.state.generatedCount,
                    mode: this.state.currentCombinationMode,
                    triedCombinationsCount: this.state.triedCombinationsCount,
                  },
                });
              }

              // Überprüfe ob es die Zieladresse ist
              if (address === this.state.targetAddress) {
                this.state.status = "completed";
                this.state.foundAddress = address;
                this.state.foundMnemonic = mnemonic;
                this.isRunning = false;

                this.emit({
                  type: "found",
                  timestamp: Date.now(),
                  data: {
                    address,
                    mnemonic,
                    attempts: this.state.generatedCount,
                    elapsedMs: Date.now() - this.state.startedAt,
                  },
                });

                onProgress?.(this.state);
                resolve(this.state);
                return;
              }

              // Fortschritts-Callback (alle 100 Versuche für regelmäßige CSV-Updates)
              if (this.state.generatedCount % 100 === 0) {
                onProgress?.(this.state);

                this.emit({
                  type: "progress",
                  timestamp: Date.now(),
                  data: {
                    generatedCount: this.state.generatedCount,
                    triedCombinationsCount: this.state.triedCombinationsCount,
                    elapsedMs: Date.now() - this.state.startedAt,
                  },
                });
              }
            }

            // Gib Event-Loop frei bevor nächster Batch
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

      this.emit({
        type: "error",
        timestamp: Date.now(),
        data: { error: this.state.errorMessage },
      });

      return this.state;
    }
  }

  /**
   * Generiere Mnemonic mit geordneten Kombinationen
   */
  private generateOrderedMnemonic(): string {
    const wordCount = 12; // 12 Wörter Mnemonic
    const words: string[] = [];

    if (this.wordList.length === 0) {
      return bip39.generateMnemonic(128, undefined, this.wordList);
    }

    for (let i = 0; i < wordCount; i++) {
      // Nutze deterministische Auswahl basierend auf tried count
      const index = (this.triedCombinations.size + i) % this.wordList.length;
      const word = this.wordList[index];
      if (word) {
        words.push(word);
      }
    }

    return words.length === wordCount ? words.join(" ") : bip39.generateMnemonic(128, undefined, this.wordList);
  }

  /**
   * Pausiere den Solver und speichere aktuellen Stand
   */
  pause(): void {
    console.log(`[BitcoinPuzzleSolver] Pausing solver. isRunning=${this.isRunning}, isPaused=${this.isPaused}, generatedCount=${this.state.generatedCount}`);
    this.isPaused = true;
    this.state.status = "paused";
    // Speichere aktuellen Stand beim Pause
    this.onProgressCallback?.(this.state);
    console.log(`[BitcoinPuzzleSolver] Paused. New status: ${this.state.status}`);
  }

  /**
   * Fortsetzen - WICHTIG: triggereProzessierung um sicherzustellen dass die Solve-Loop wirklich weitermacht
   */
  resume(): void {
    console.log(`[BitcoinPuzzleSolver] Resuming solver. isRunning=${this.isRunning}, isPaused=${this.isPaused}, generatedCount=${this.state.generatedCount}`);
    this.isPaused = false;
    this.state.status = "running";
    console.log(`[BitcoinPuzzleSolver] Resumed. isPaused=${this.isPaused}, status=${this.state.status}`);

    // KRITISCH: Wecke die Solve-Loop auf damit sie nicht in setTimeout wartet
    // Ohne das wird die Loop nie wieder aufgerufen wenn isPaused true war
    // Wir können das nicht direkt tun, also sind wir abhängig davon dass der Timer die Loop aufruft
    // Dies ist ein Design-Problem das grundlegend umgebaut werden muss
  }

  /**
   * Stoppe den Solver
   */
  stop(): void {
    this.isRunning = false;
    this.isPaused = false;
    this.state.status = "idle";
  }

  /**
   * Hole aktuellen Status
   */
  getState(): SolverState {
    return { ...this.state };
  }

  /**
   * Hole Anzahl versuchter Kombinationen
   */
  getTriedCombinationsCount(): number {
    return this.state.triedCombinationsCount;
  }

  /**
   * Hole aktuelle Strategie-Mode
   */
  getCurrentMode(): string {
    return this.state.currentCombinationMode;
  }

  /**
   * Hole letzte 50 verarbeiteten Phrasen mit Adressen
   */
  getRecentAttempts(): AttemptRecord[] {
    return [...this.recentAttempts];
  }

  /**
   * Setze letzte Versuche (z.B. von gespeichertem State)
   */
  setRecentAttempts(attempts: AttemptRecord[]): void {
    this.recentAttempts = [...attempts.slice(-50)]; // Nur letzte 50
  }

  /**
   * Setze alle bereits versuchten Kombinationen (beim Restore)
   */
  setTriedCombinations(attempts: AttemptRecord[]): void {
    this.triedCombinations.clear();
    for (const attempt of attempts) {
      this.triedCombinations.add(attempt.mnemonic);
    }
    this.state.triedCombinationsCount = this.triedCombinations.size;
  }

  /**
   * Registriere Callback um externe Phrase-Datenbank zu prüfen
   */
  setPhraseExistsCallback(callback: (phrase: string) => boolean): void {
    this.phraseExistsCallback = callback;
  }

  /**
   * Generiere Bitcoin-Adresse aus Mnemonic (P2PKH)
   */
  private generateAddressFromMnemonic(mnemonic: string): string {
    try {
      const seed = bip39.mnemonicToSeedSync(mnemonic);
      const root = bip32.fromSeed(seed);

      // BIP44 Path für Bitcoin: m/44'/0'/0'/0/0
      const child = root.derivePath("m/44'/0'/0'/0/0");

      if (!child.publicKey) {
        throw new Error("Failed to derive public key");
      }

      // Erstelle P2PKH Adresse (Legacy Bitcoin Adresse)
      const address = bitcoin.payments.p2pkh({ pubkey: child.publicKey }).address;

      if (!address) {
        throw new Error("Failed to generate address");
      }

      return address;
    } catch (error) {
      throw new Error(`Address generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export { BitcoinPuzzleSolver };
