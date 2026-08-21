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

/** Obergrenze für den Puffer noch nicht persistierter Versuche (Schutz gegen Speicherleck). */
const MAX_PENDING_ATTEMPTS = 50_000;

class BitcoinPuzzleSolver {
  private state: SolverState;
  private isRunning = false;
  private isPaused = false;
  /** true, solange die Batch-Loop tatsächlich läuft. Ein restaurierter Solver hat keine Loop. */
  private loopAlive = false;
  private loopPromise: Promise<SolverState> | null = null;
  /** Startzeitpunkt/Zählerstand des AKTUELLEN Laufs - Basis für eine ehrliche /Sek-Rate. */
  private runStartedAt = Date.now();
  private runStartCount = 0;
  private wordList: string[];
  private triedCombinations: Set<string> = new Set(); // Intern nur Set für Duplikat-Check
  private recentAttempts: AttemptRecord[] = []; // Letzte 50 verarbeiteten Phrasen mit Adressen
  private pendingAttempts: AttemptRecord[] = []; // Noch nicht in die CSV geschriebene Versuche
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
    // Ein pausiert gespeichertes Puzzle muss auch pausiert wieder auftauchen - sonst
    // sieht die UI "idle" und der Resume-Pfad hält es für einen frischen Solver.
    if (savedState.status !== undefined) {
      this.state.status = savedState.status === "running" ? "paused" : savedState.status;
    }
    if (savedState.foundAddress !== undefined && savedState.foundAddress) {
      this.state.foundAddress = savedState.foundAddress;
    }
    if (savedState.foundMnemonic !== undefined && savedState.foundMnemonic) {
      this.state.foundMnemonic = savedState.foundMnemonic;
      this.state.status = "completed";
    }
    if (savedState.errorMessage !== undefined) {
      this.state.errorMessage = savedState.errorMessage;
    }
    this.runStartCount = this.state.generatedCount;
  }

  /**
   * Starte den Solver-Prozess mit verschiedenen Kombinationsstrategien
   */
  async start(onProgress?: (state: SolverState) => void): Promise<SolverState> {
    if (onProgress) {
      this.onProgressCallback = onProgress; // Speichere Callback für spätere Nutzung (z.B. beim Pause)
    }

    // Zweiter start() auf denselben Solver würde eine zweite Batch-Loop auf denselben
    // State setzen (doppelte Zähler, doppelte CSV-Writes). Stattdessen nur entpausieren.
    if (this.loopAlive && this.loopPromise) {
      console.log(`[BitcoinPuzzleSolver] start() ignored - loop already alive. Unpausing instead.`);
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
          const finish = (state: SolverState) => {
            this.loopAlive = false;
            this.loopPromise = null;
            resolve(state);
          };
          const processNextBatch = () => {
            if (!this.isRunning) {
              this.state.status = "idle";
              this.emit({
                type: "stopped",
                timestamp: Date.now(),
                data: { reason: "manual_stop", attempts: this.state.generatedCount },
              });
              finish(this.state);
              return;
            }

            // Pausiert: NICHT mit setImmediate weiterspinnen - das ist ein Busy-Wait, der
            // einen CPU-Kern voll auslastet, solange das Puzzle "pausiert" ist.
            if (this.isPaused) {
              setTimeout(processNextBatch, 250);
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
                // Die geordnete Phrase ist deterministisch. Wäre sie ein Duplikat und wir
                // würden nur `continue`, käme sie in der nächsten Iteration erneut heraus
                // (generatedCount unverändert => gleiche Bedingung) - Endlosschleife.
                if (this.triedCombinations.has(mnemonic)) {
                  this.state.currentCombinationMode = "random";
                  mnemonic = bip39.generateMnemonic(128, undefined, this.wordList);
                }
              } else {
                this.state.currentCombinationMode = "random";
                mnemonic = bip39.generateMnemonic(128, undefined, this.wordList);
              }

              // Überprüfe auf Duplikate (interne Datenbank - schnell).
              // Das Set ist beim Restore aus der kompletten CSV vorbefüllt, deckt also
              // auch frühere Läufe ab.
              if (this.triedCombinations.has(mnemonic)) {
                continue;
              }

              // Zusätzliche externe Prüfung (z.B. manuell markierte Phrasen).
              // Muss O(1) sein - der Callback darf hier keine Datei lesen.
              if (this.phraseExistsCallback && this.phraseExistsCallback(mnemonic)) {
                this.triedCombinations.add(mnemonic);
                continue;
              }

              this.triedCombinations.add(mnemonic);
              this.state.triedCombinationsCount++;

              if (this.state.generatedCount % 10000 === 0) {
                console.log(`[BitcoinPuzzleSolver] Progress: ${this.state.generatedCount} generated, ${this.state.triedCombinationsCount} tried`);
              }

              // Generiere Bitcoin-Adresse
              const address = this.generateAddressFromMnemonic(mnemonic);

              // recentAttempts = reines Anzeige-Fenster (letzte 50).
              // pendingAttempts = Persistenz-Puffer: er wird beim Speichern geleert, damit
              // KEIN Versuch verloren geht. (Vorher wurde alle 100 Versuche nur das
              // 50er-Fenster geschrieben - die Hälfte landete nie in der CSV.)
              const attempt = { mnemonic, address };
              this.recentAttempts.push(attempt);
              if (this.recentAttempts.length > 50) {
                this.recentAttempts.shift();
              }
              this.pendingAttempts.push(attempt);
              if (this.pendingAttempts.length > MAX_PENDING_ATTEMPTS) {
                this.pendingAttempts.shift();
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

                this.onProgressCallback?.(this.state);
                finish(this.state);
                return;
              }

              // Fortschritts-Callback (alle 100 Versuche für regelmäßige CSV-Updates)
              if (this.state.generatedCount % 100 === 0) {
                this.onProgressCallback?.(this.state);

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
      this.loopAlive = false;
      this.loopPromise = null;

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
   * Fortsetzen.
   *
   * Hebt nur das Pause-Flag auf. Ob dahinter überhaupt eine Loop wartet, weiß der Aufrufer
   * über {@link isLoopAlive} - ein aus dem State-File restaurierter Solver hat keine, der
   * muss mit start() angeworfen werden.
   */
  resume(): void {
    console.log(`[BitcoinPuzzleSolver] Resuming solver. loopAlive=${this.loopAlive}, isPaused=${this.isPaused}, generatedCount=${this.state.generatedCount}`);
    this.isPaused = false;
    this.isRunning = true;
    this.state.status = "running";
    // Rate-Messung neu aufsetzen, sonst verwässert die Pausenzeit die /Sek-Anzeige.
    this.runStartedAt = Date.now();
    this.runStartCount = this.state.generatedCount;
  }

  /**
   * Läuft die Batch-Loop gerade tatsächlich (inkl. pausiert-wartend)?
   */
  isLoopAlive(): boolean {
    return this.loopAlive;
  }

  /**
   * Adressen pro Sekunde im AKTUELLEN Lauf.
   * (Über state.startedAt gerechnet ergäbe das bei einem Puzzle, das vor Wochen erstellt
   * wurde, praktisch immer 0.)
   */
  getRatePerSecond(): number {
    if (!this.loopAlive || this.isPaused) return 0;
    const elapsedMs = Date.now() - this.runStartedAt;
    if (elapsedMs <= 0) return 0;
    const delta = this.state.generatedCount - this.runStartCount;
    if (delta <= 0) return 0;
    return Math.round((delta / elapsedMs) * 1000);
  }

  /**
   * Sekunden seit Start des aktuellen Laufs (0 wenn nichts läuft).
   */
  getRunElapsedSeconds(): number {
    if (!this.loopAlive) return 0;
    return Math.round((Date.now() - this.runStartedAt) / 1000);
  }

  /**
   * Stoppe den Solver
   */
  stop(): void {
    this.isRunning = false;
    this.isPaused = false;
    if (this.state.status !== "completed" && this.state.status !== "error") {
      this.state.status = "idle";
    }
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
   * Hole alle seit dem letzten Aufruf neu erzeugten Versuche und leere den Puffer.
   * Der Aufrufer ist damit verantwortlich, sie zu persistieren.
   */
  drainPendingAttempts(): AttemptRecord[] {
    const drained = this.pendingAttempts;
    this.pendingAttempts = [];
    return drained;
  }

  /**
   * Setze alle bereits versuchten Kombinationen (beim Restore).
   *
   * Additiv und niemals zählerreduzierend: früher wurde hier mit den letzten 50
   * CSV-Zeilen überschrieben, wodurch ein Puzzle mit 118.000 Versuchen nach jedem
   * Neustart/Resume wieder "50 versucht" anzeigte.
   */
  setTriedCombinations(attempts: AttemptRecord[]): void {
    for (const attempt of attempts) {
      this.triedCombinations.add(attempt.mnemonic);
    }
    this.state.triedCombinationsCount = Math.max(
      this.state.triedCombinationsCount,
      this.triedCombinations.size
    );
  }

  /**
   * Korrigiere den Versuchs-Zähler nach oben, ohne das Duplikat-Set anzufassen.
   *
   * Nutzt der Service nach einem Hintergrund-Index-Build: alte State-Files enthalten
   * oft einen veralteten niedrigen Zähler (vor dem drainPendingAttempts-Fix wurde nur
   * das 50er-Fenster gespeichert). Die CSV ist die Wahrheit - ihr gestreamter Index
   * kennt die echte Zahl, und der Zähler darf nicht niedriger stehen als die Datei.
   */
  raiseTriedCombinationsCount(count: number): void {
    this.state.triedCombinationsCount = Math.max(this.state.triedCombinationsCount, count);
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
