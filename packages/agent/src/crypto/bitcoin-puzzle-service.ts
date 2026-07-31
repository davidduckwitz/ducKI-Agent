import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { BitcoinPuzzleSolver, type SolverState, type SolverConfig, type AttemptRecord } from "./bitcoin-puzzle-solver";
import type { DatabaseService } from "@ducki/database";

/**
 * Generiere deterministische ID basierend auf targetAddress
 * So wird der gleiche Puzzle immer die gleiche ID haben
 */
function generateDeterministicId(targetAddress: string): string {
  // Nutze SHA256 hash von der targetAddress um eine stabile ID zu generieren
  const hash = createHash("sha256").update(targetAddress).digest("hex");
  return `puzzle-${hash.substring(0, 12)}`;
}

export interface PuzzleMetadata {
  id: string;
  name: string;
  targetAddress: string;
  infoUrl?: string;
  createdAt: number;
}

interface ActivePuzzle {
  metadata: PuzzleMetadata;
  solver: BitcoinPuzzleSolver;
  promise: Promise<SolverState> | null;
}

/**
 * Generiere alle Kombinationen für eine unvollständige Mnemonic
 * z.B. "word1 word2 __ word4" generiert alle 2048^(Anzahl __) Kombinationen
 */
function generatePartialMnemonicCombinations(
  partialPhrase: string,
  wordList: string[]
): string[] {
  const words = partialPhrase.split(/\s+/).filter((w) => w.trim());

  // Finde Positionen von fehlenden Wörtern (leere strings oder "__")
  const missingPositions: number[] = [];
  words.forEach((word, idx) => {
    if (!word || word === "__" || word === "?") {
      missingPositions.push(idx);
    }
  });

  if (missingPositions.length === 0) {
    // Keine fehlenden Wörter, gib die Phrase zurück
    return [partialPhrase];
  }

  if (missingPositions.length > 2) {
    console.warn(`[generatePartialMnemonicCombinations] Too many missing words (${missingPositions.length}). Max 2 supported.`);
    return [];
  }

  console.log(
    `[generatePartialMnemonicCombinations] Generating combinations for ${missingPositions.length} missing positions`
  );

  const combinations: string[] = [];
  const totalCombinations = Math.pow(wordList.length, missingPositions.length);

  // Limit to prevent explosion (max 1M combinations to keep it fast)
  if (totalCombinations > 1_000_000) {
    console.warn(
      `[generatePartialMnemonicCombinations] Too many combinations (${totalCombinations}). Max 1M supported.`
    );
    return [];
  }

  // Generiere alle Kombinationen
  let count = 0;
  const generateRecursive = (posIdx: number, currentWords: string[]) => {
    if (posIdx === missingPositions.length) {
      combinations.push(currentWords.join(" "));
      count++;
      if (count % 100_000 === 0) {
        console.log(
          `[generatePartialMnemonicCombinations] Generated ${count}/${totalCombinations} combinations`
        );
      }
      return;
    }

    const position = missingPositions[posIdx]!;
    for (const word of wordList) {
      const newWords = [...currentWords];
      newWords[position] = word;
      generateRecursive(posIdx + 1, newWords);
    }
  };

  generateRecursive(0, words.slice());
  console.log(
    `[generatePartialMnemonicCombinations] Generated ${combinations.length} combinations`
  );

  return combinations;
}

/**
 * Parse CSV-Zeile korrekt mit Quotes
 */
function parseCSVLine(line: string): [string, string] | null {
  const match = line.match(/^"([^"]*(?:""[^"]*)*)","([^"]*(?:""[^"]*)*)"$/);
  if (match && match[1] && match[2]) {
    // Unescape escaped quotes ("")
    const mnemonic = match[1].replace(/""/g, '"');
    const address = match[2].replace(/""/g, '"');
    return [mnemonic, address];
  }
  return null;
}

/**
 * Service zur Verwaltung mehrerer Bitcoin Puzzle Solver-Prozesse
 * Singleton - nur eine Instanz pro Prozess
 */
export class BitcoinPuzzleService {
  private static instance: BitcoinPuzzleService;
  private activePuzzles = new Map<string, ActivePuzzle>();
  private wordList: string[] = [];
  private db: DatabaseService | null = null;
  private attemptsCsvDir: string;

  private constructor() {
    this.loadWordList();
    // Erstelle CSV Directory für Puzzle Attempts
    this.attemptsCsvDir = resolve(
      process.env["SHARED_WORKSPACE_PATH"] ?? "./shared-workspace",
      "bitcoin-puzzle-attempts"
    );
    if (!existsSync(this.attemptsCsvDir)) {
      mkdirSync(this.attemptsCsvDir, { recursive: true });
    }
  }

  static getInstance(): BitcoinPuzzleService {
    if (!BitcoinPuzzleService.instance) {
      BitcoinPuzzleService.instance = new BitcoinPuzzleService();
    }
    return BitcoinPuzzleService.instance;
  }

  /**
   * Lade BIP39 Wortliste
   */
  private loadWordList(): void {
    try {
      const wordListPath = resolve(
        process.env["SHARED_WORKSPACE_PATH"] ?? "./shared-workspace",
        "btc-puzzle",
        "english.txt"
      );
      const content = readFileSync(wordListPath, "utf-8");
      this.wordList = content.split("\n").filter((word) => word.trim().length > 0);
      console.log(`Loaded ${this.wordList.length} BIP39 words`);
    } catch (error) {
      console.error("Failed to load word list:", error);
      this.wordList = [];
    }
  }

  /**
   * Setze Datenbank für Speicherung
   */
  setDatabase(db: DatabaseService): void {
    this.db = db;
  }

  /**
   * Lade und restore Puzzles von gespeicherten State-Files beim Start
   */
  async initializeFromDatabase(): Promise<void> {
    try {
      console.log(`[BitcoinPuzzleService] Initializing from database...`);

      // Lese alle State JSON Files aus dem CSV Directory
      if (!existsSync(this.attemptsCsvDir)) {
        console.log(`[BitcoinPuzzleService] Attempts directory not found: ${this.attemptsCsvDir}`);
        return;
      }

      const { readdirSync } = await import("node:fs");
      const stateFiles = readdirSync(this.attemptsCsvDir).filter((f: string) => f.endsWith("-state.json"));

      console.log(`[BitcoinPuzzleService] Found ${stateFiles.length} saved puzzle states`);

      for (const file of stateFiles) {
        try {
          const stateFile = resolve(this.attemptsCsvDir, file);
          const stateJson = readFileSync(stateFile, "utf-8");
          const saved = JSON.parse(stateJson);

          // Ignoriere bereits laufende Puzzles
          if (this.activePuzzles.has(saved.id)) continue;

          // Erstelle neuen Solver mit gespeichertem Stand
          const solver = new BitcoinPuzzleSolver(this.wordList, {
            targetAddress: saved.targetAddress,
            startMnemonic: undefined,
            batchSize: 100,
          });

          // Setze Callback um externe Phrase-Datenbank zu prüfen
          solver.setPhraseExistsCallback((phrase) => {
            const result = this.phraseExistsAnyPuzzle(phrase);
            return result.exists;
          });

          // Restore den Stand
          solver.restoreState({
            triedCombinationsCount: saved.triedCombinationsCount,
            generatedCount: saved.generatedCount,
            currentCombinationMode: saved.currentCombinationMode,
            startedAt: new Date(saved.startedAt).getTime(),
            lastCheckAt: new Date(saved.lastCheckAt).getTime(),
            foundMnemonic: saved.foundMnemonic || undefined,
            foundAddress: saved.foundAddress || undefined,
            errorMessage: saved.errorMessage || undefined,
          });

          // Lade letzte 50 Versuche von CSV für UI-Display
          const recentAttempts = this.getRecentAttemptsFromCsv(saved.id);
          if (recentAttempts.length > 0) {
            solver.setRecentAttempts(recentAttempts);
            // Setze auch die letzten 50 Attempts als "bereits versucht" im Memory
            // Dadurch wird der Solver nicht wieder die gleichen Phrasen generieren
            solver.setTriedCombinations(recentAttempts);
          }

          // Setze Callback um externe Phrase-Datenbank zu prüfen
          // WICHTIG: Nur das aktuelle Puzzle prüfen (nicht alle), um Performance zu halten
          // Dies verhindert dass der Solver Phrasen regeneriert die bereits versucht wurden
          const puzzleId = saved.id;
          solver.setPhraseExistsCallback((phrase) => {
            return this.phraseExistsInPuzzle(puzzleId, phrase);
          });

          console.log(`[BitcoinPuzzleService] Puzzle ${saved.id} restored. CSV Search API active for duplicate detection.`);

          // Speichere als inactive Puzzle (wird nur restauriert wenn User auf start klickt)
          const metadata: PuzzleMetadata = {
            id: saved.id,
            name: saved.name,
            targetAddress: saved.targetAddress,
            infoUrl: saved.infoUrl,
            createdAt: new Date(saved.createdAt).getTime(),
          };

          this.activePuzzles.set(saved.id, {
            metadata,
            solver,
            promise: null,
          });

          console.log(`[BitcoinPuzzleService] Restored puzzle from state file: ${saved.id}`);
        } catch (err) {
          console.error(`[BitcoinPuzzleService] Error reading state file ${file}:`, err);
        }
      }
      console.log(`[BitcoinPuzzleService] Initialization complete. Total puzzles loaded: ${this.activePuzzles.size}`);
    } catch (error) {
      console.error("[BitcoinPuzzleService] Error initializing from saved states:", error);
    }
  }

  /**
   * Starte neuen Puzzle-Solver
   */
  async startPuzzle(config: SolverConfig & { name?: string; infoUrl?: string }): Promise<{ id: string; state: SolverState }> {
    if (this.wordList.length === 0) {
      return {
        id: "",
        state: {
          targetAddress: config.targetAddress,
          generatedCount: 0,
          startedAt: Date.now(),
          lastCheckAt: Date.now(),
          status: "error",
          errorMessage: "Word list not loaded",
          triedCombinationsCount: 0,
          currentCombinationMode: "random",
        },
      };
    }

    // Generiere deterministische ID aus targetAddress
    const puzzleId = generateDeterministicId(config.targetAddress);

    // Überprüfe ob Puzzle bereits existiert und lade seinen Stand
    let existingPuzzle = this.activePuzzles.get(puzzleId);
    if (existingPuzzle && existingPuzzle.solver.getState().status === "running") {
      // Puzzle läuft bereits
      console.log(`[BitcoinPuzzleService] Puzzle ${puzzleId} already running`);
      return { id: puzzleId, state: existingPuzzle.solver.getState() };
    }

    const metadata: PuzzleMetadata = {
      id: puzzleId,
      name: config.name || `Puzzle ${new Date().toLocaleString()}`,
      targetAddress: config.targetAddress,
      infoUrl: config.infoUrl,
      createdAt: Date.now(),
    };

    const solver = new BitcoinPuzzleSolver(this.wordList, config);

    // Setze Callback um externe Phrase-Datenbank zu prüfen
    // WICHTIG: Nur diese Puzzle CSV prüfen (nicht alle), um Performance zu halten
    solver.setPhraseExistsCallback((phrase) => {
      return this.phraseExistsInPuzzle(puzzleId, phrase);
    });

    // Starte Solver in Background mit Error-Handling
    const promise = solver
      .start((state) => {
        // Fire-and-forget: Speichere im Hintergrund ohne zu warten
        this.savePuzzleProgress(puzzleId, state).catch((err) => {
          console.error(`[BitcoinPuzzleService] Save progress error: ${err}`);
        });
      })
      .catch((error) => {
        console.error(`[BitcoinPuzzleService] Error in puzzle ${puzzleId}:`, error);
        // Puzzle bleibt in der Map aber mit error status
        const errorState = solver.getState();
        errorState.status = "error";
        errorState.errorMessage = error instanceof Error ? error.message : String(error);
        return errorState;
      });

    // Registriere Event-Listener für automatisches Wallet-Import bei Fund
    solver.on((event) => {
      if (event.type === "found" && event.data?.mnemonic && typeof event.data.mnemonic === "string") {
        console.log(`[BitcoinPuzzleService] Puzzle ${puzzleId} found! Auto-importing to wallet...`);
        this.importFoundMnemonicToWallet(event.data.mnemonic as string, `Bitcoin Puzzle ${puzzleId}`)
          .then(() => console.log(`[BitcoinPuzzleService] Successfully imported mnemonic for puzzle ${puzzleId}`))
          .catch((err) => console.error(`[BitcoinPuzzleService] Error importing mnemonic for puzzle ${puzzleId}:`, err));
      }
    });

    this.activePuzzles.set(puzzleId, {
      metadata,
      solver,
      promise,
    });

    // Speichere initial State und CSV Header sofort nach Erstellung
    const initialState = solver.getState();
    console.log(`[BitcoinPuzzleService] Puzzle created: ${puzzleId}. Saving initial state...`);
    this.savePuzzleProgress(puzzleId, initialState).catch((err) => {
      console.error(`[BitcoinPuzzleService] Error saving initial puzzle state: ${err}`);
    });

    // Prüfe ob die Zieladresse bereits in einem anderen Puzzle existiert
    console.log(`[BitcoinPuzzleService] Searching for target address in existing CSVs...`);
    const foundMnemonic = this.searchAddressInAllCSVs(config.targetAddress);
    if (foundMnemonic) {
      console.log(
        `[BitcoinPuzzleService] ✓ Found target address in existing CSV! Mnemonic: ${foundMnemonic.substring(0, 40)}...`
      );
      // Markiere als gefunden und importiere sofort
      const solvedState = solver.getState();
      solvedState.status = "completed";
      solvedState.foundMnemonic = foundMnemonic;
      solvedState.foundAddress = config.targetAddress;

      // Stoppe den Solver da er nicht mehr läuft
      solver.stop();

      // Speichere den gelösten State
      this.savePuzzleProgress(puzzleId, solvedState).catch((err) => {
        console.error(`[BitcoinPuzzleService] Error saving solved state: ${err}`);
      });

      // Auto-import zur Wallet
      this.importFoundMnemonicToWallet(foundMnemonic, `Bitcoin Puzzle ${puzzleId}`)
        .then(() => console.log(`[BitcoinPuzzleService] Successfully imported mnemonic for puzzle ${puzzleId}`))
        .catch((err) => console.error(`[BitcoinPuzzleService] Error importing mnemonic:`, err));

      return { id: puzzleId, state: solvedState };
    }

    return { id: puzzleId, state: initialState };
  }

  /**
   * Liste alle aktiven Puzzles auf
   */
  listPuzzles(): Array<{ metadata: PuzzleMetadata; state: SolverState }> {
    return Array.from(this.activePuzzles.values()).map((puzzle) => ({
      metadata: puzzle.metadata,
      state: puzzle.solver.getState(),
    }));
  }

  /**
   * Hole Puzzle-Details
   */
  getPuzzle(puzzleId: string): { metadata: PuzzleMetadata; state: SolverState } | null {
    const puzzle = this.activePuzzles.get(puzzleId);
    if (!puzzle) return null;

    return {
      metadata: puzzle.metadata,
      state: puzzle.solver.getState(),
    };
  }

  /**
   * Pausiere Puzzle
   */
  pausePuzzle(puzzleId: string): SolverState | null {
    const puzzle = this.activePuzzles.get(puzzleId);
    if (!puzzle) {
      console.warn(`[BitcoinPuzzleService] Puzzle not found for pause: ${puzzleId}`);
      return null;
    }
    console.log(`[BitcoinPuzzleService] Pausing puzzle: ${puzzleId}`);
    puzzle.solver.pause();
    const state = puzzle.solver.getState();
    console.log(`[BitcoinPuzzleService] Puzzle paused, status: ${state.status}`);
    // Speichere sofort beim Pause
    this.savePuzzleProgress(puzzleId, state).catch((err) => {
      console.error(`[BitcoinPuzzleService] Error saving on pause: ${err}`);
    });
    return state;
  }

  /**
   * Fortsetzen
   */
  resumePuzzle(puzzleId: string): SolverState | null {
    const puzzle = this.activePuzzles.get(puzzleId);
    if (!puzzle) return null;

    const currentState = puzzle.solver.getState();
    console.log(
      `[BitcoinPuzzleService] Resuming puzzle ${puzzleId}. Current state: generatedCount=${currentState.generatedCount}, status=${currentState.status}`
    );

    // WICHTIG: Bei Pause-Resume funktioniert die Promise-basierte Loop nicht richtig
    // Lösung: Starte den Solver komplett neu mit gespeichertem State
    if (currentState.status === "paused") {
      // Stoppe den alten Solver
      puzzle.solver.stop();

      // Erstelle neuen Solver mit gleicher Config
      const newSolver = new BitcoinPuzzleSolver(this.wordList, {
        targetAddress: puzzle.metadata.targetAddress,
        startMnemonic: undefined,
        batchSize: 100,
      });

      // Restore den gespeicherten State in den neuen Solver
      newSolver.restoreState(currentState);

      // Lade letzte 50 Versuche
      const recentAttempts = this.getRecentAttemptsFromCsv(puzzleId);
      if (recentAttempts.length > 0) {
        newSolver.setRecentAttempts(recentAttempts);
        newSolver.setTriedCombinations(recentAttempts);
      }

      // Setze CSV Search Callback
      newSolver.setPhraseExistsCallback((phrase) => {
        return this.phraseExistsInPuzzle(puzzleId, phrase);
      });

      // Starte neuen Solver
      const promise = newSolver.start((state) => {
        this.savePuzzleProgress(puzzleId, state).catch((err) => {
          console.error(`[BitcoinPuzzleService] Error saving progress: ${err}`);
        });
      });
      promise.catch((err) => {
        console.error(`[BitcoinPuzzleService] Solver error: ${err}`);
      });

      // Update the active puzzle with new solver
      puzzle.solver = newSolver;
      puzzle.promise = promise;

      console.log(`[BitcoinPuzzleService] Puzzle ${puzzleId} restarted after pause`);
      return newSolver.getState();
    }

    // Falls nicht pausiert, nutze nur die resume() Methode
    puzzle.solver.resume();
    return puzzle.solver.getState();
  }

  /**
   * Stoppe Puzzle
   */
  stopPuzzle(puzzleId: string): SolverState | null {
    const puzzle = this.activePuzzles.get(puzzleId);
    if (!puzzle) return null;
    puzzle.solver.stop();
    const state = puzzle.solver.getState();
    this.activePuzzles.delete(puzzleId);
    return state;
  }

  /**
   * Lösche Puzzle und alle zugehörigen Dateien
   */
  deletePuzzle(puzzleId: string): boolean {
    try {
      let deletedAny = false;

      // Stoppe Solver falls aktiv
      const puzzle = this.activePuzzles.get(puzzleId);
      if (puzzle) {
        puzzle.solver.stop();
        this.activePuzzles.delete(puzzleId);
        deletedAny = true;
        console.log(`[BitcoinPuzzleService] Stopped active puzzle: ${puzzleId}`);
      }

      // Lösche State-Datei
      const stateFile = resolve(this.attemptsCsvDir, `${puzzleId}-state.json`);
      if (existsSync(stateFile)) {
        unlinkSync(stateFile);
        deletedAny = true;
        console.log(`[BitcoinPuzzleService] Deleted state file: ${stateFile}`);
      }

      // Lösche CSV-Datei
      const csvFile = resolve(this.attemptsCsvDir, `${puzzleId}-attempts.csv`);
      if (existsSync(csvFile)) {
        unlinkSync(csvFile);
        deletedAny = true;
        console.log(`[BitcoinPuzzleService] Deleted CSV file: ${csvFile}`);
      }

      if (deletedAny) {
        console.log(`[BitcoinPuzzleService] Puzzle deleted: ${puzzleId}`);
        return true;
      } else {
        console.warn(`[BitcoinPuzzleService] No files found for puzzle: ${puzzleId}`);
        return false;
      }
    } catch (error) {
      console.error(`[BitcoinPuzzleService] Error deleting puzzle ${puzzleId}:`, error);
      return false;
    }
  }

  /**
   * Suche eine Adresse in allen Puzzle CSVs
   */
  private searchAddressInAllCSVs(targetAddress: string): string | null {
    try {
      const csvFiles = readdirSync(this.attemptsCsvDir)
        .filter((f) => f.endsWith("-attempts.csv"));

      for (const csvFile of csvFiles) {
        const filePath = resolve(this.attemptsCsvDir, csvFile);
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim().length > 0);

        // Skip header
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          try {
            const match = line.match(/^"([^"]*(?:""[^"]*)*)","([^"]*(?:""[^"]*)*)"/);
            if (match && match[1] && match[2]) {
              const mnemonic = match[1].replace(/""/g, '"');
              const address = match[2].replace(/""/g, '"');

              if (address === targetAddress) {
                console.log(`[BitcoinPuzzleService] Found target address in ${csvFile}: ${address}`);
                return mnemonic;
              }
            }
          } catch (e) {
            // Skip malformed lines
            continue;
          }
        }
      }

      return null;
    } catch (error) {
      console.error(`[BitcoinPuzzleService] Error searching CSVs for address:`, error);
      return null;
    }
  }

  /**
   * Markiere eine Phrase manuell als bereits versucht
   * Unterstützt auch unvollständige Phrasen mit __ oder ? Platzhaltern
   * z.B. "word1 word2 __ word4 __ word6" generiert alle Kombinationen
   */
  markPhraseAsTried(
    puzzleId: string,
    phrase: string,
    address: string = ""
  ): { success: boolean; error?: string; generatedCount?: number } {
    try {
      const phraseStr = phrase.trim();

      // Prüfe ob es eine unvollständige Phrase ist
      if (phraseStr.includes("__") || phraseStr.includes("?")) {
        console.log(
          `[BitcoinPuzzleService] Partial phrase detected. Generating combinations for puzzle ${puzzleId}`
        );

        // Generiere alle Kombinationen
        const combinations = generatePartialMnemonicCombinations(
          phraseStr,
          this.wordList
        );

        if (combinations.length === 0) {
          return {
            success: false,
            error: "Failed to generate combinations or too many missing words (max 3)",
          };
        }

        // Schreibe alle Kombinationen in CSV
        const attempts = combinations.map((combo) => ({
          mnemonic: combo,
          address: "", // Adresse können wir nicht vorab kennen
        }));

        console.log(
          `[BitcoinPuzzleService] Saving ${attempts.length} generated combinations to CSV`
        );
        this.saveAttemptsToCSV(puzzleId, attempts);

        // Update Solver wenn aktiv
        const puzzle = this.activePuzzles.get(puzzleId);
        if (puzzle) {
          const recentAttempts = this.getRecentAttemptsFromCsv(puzzleId);
          if (recentAttempts.length > 0) {
            puzzle.solver.setRecentAttempts(recentAttempts);
            puzzle.solver.setTriedCombinations(recentAttempts);
          }
        }

        return { success: true, generatedCount: attempts.length };
      } else {
        // Vollständige Phrase - normale Verarbeitung
        console.log(
          `[BitcoinPuzzleService] Marking complete phrase as tried for puzzle ${puzzleId}`
        );

        this.saveAttemptsToCSV(puzzleId, [{ mnemonic: phraseStr, address }]);

        const puzzle = this.activePuzzles.get(puzzleId);
        if (puzzle) {
          const recentAttempts = this.getRecentAttemptsFromCsv(puzzleId);
          if (recentAttempts.length > 0) {
            puzzle.solver.setRecentAttempts(recentAttempts);
            puzzle.solver.setTriedCombinations(recentAttempts);
          }

          // Prüfe ob diese Phrase die Zieladresse generiert
          if (address === puzzle.metadata.targetAddress) {
            console.log(
              `[BitcoinPuzzleService] Found matching address! Marking puzzle ${puzzleId} as completed and importing to wallet...`
            );

            // Markiere Puzzle als solved
            const currentState = puzzle.solver.getState();
            currentState.status = "completed";
            currentState.foundMnemonic = phraseStr;
            currentState.foundAddress = address;

            // Speichere den solved-State
            this.savePuzzleProgress(puzzleId, currentState).catch((err) => {
              console.error(`[BitcoinPuzzleService] Error saving solved state: ${err}`);
            });

            // Auto-import zu Wallet
            this.importFoundMnemonicToWallet(phraseStr, `Bitcoin Puzzle ${puzzleId}`)
              .then(() => console.log(`[BitcoinPuzzleService] Successfully imported mnemonic for puzzle ${puzzleId}`))
              .catch((err) => console.error(`[BitcoinPuzzleService] Error importing mnemonic:`, err));
          }
        }

        return { success: true, generatedCount: 1 };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[BitcoinPuzzleService] Error marking phrase as tried: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Aktualisiere Puzzle-Metadaten (Name, infoUrl)
   */
  updatePuzzleMetadata(puzzleId: string, data: { name?: string; infoUrl?: string }): PuzzleMetadata | null {
    const puzzle = this.activePuzzles.get(puzzleId);
    if (!puzzle) return null;

    if (data.name !== undefined) {
      puzzle.metadata.name = data.name;
    }
    if (data.infoUrl !== undefined) {
      puzzle.metadata.infoUrl = data.infoUrl;
    }

    console.log(`[BitcoinPuzzleService] Updated puzzle metadata: ${puzzleId}`);
    return puzzle.metadata;
  }

  /**
   * Hole Puzzle-Info mit Laufzeit-Statistiken und Kombinationsdetails
   */
  getPuzzleInfo(puzzleId: string): {
    metadata: PuzzleMetadata;
    state: SolverState;
    isRunning: boolean;
    elapsedSeconds?: number;
    addressesPerSecond?: number;
    triedCombinationsCount?: number;
    currentCombinationMode?: string;
    recentAttempts?: AttemptRecord[];
  } | null {
    const puzzle = this.activePuzzles.get(puzzleId);
    if (!puzzle) return null;

    const state = puzzle.solver.getState();
    const isRunning = state.status === "running";
    const elapsedMs = Date.now() - state.startedAt;
    const elapsedSeconds = Math.round(elapsedMs / 1000);
    const addressesPerSecond = Math.round((state.generatedCount / elapsedMs) * 1000);

    return {
      metadata: puzzle.metadata,
      state,
      isRunning,
      elapsedSeconds,
      addressesPerSecond,
      triedCombinationsCount: state.triedCombinationsCount,
      currentCombinationMode: state.currentCombinationMode,
      recentAttempts: puzzle.solver.getRecentAttempts(),
    };
  }

  /**
   * Registriere Event Listener für Puzzle
   */
  onPuzzleEvent(puzzleId: string, listener: (event: any) => void): () => void {
    const puzzle = this.activePuzzles.get(puzzleId);
    if (!puzzle) {
      return () => {};
    }

    puzzle.solver.on(listener);

    // Rückgabe: Funktion zum Entfernen des Listeners
    return () => {
      puzzle.solver.off(listener);
    };
  }

  /**
   * Speichere Puzzle-Fortschritt für Persistence (JSON State + CSV Attempts)
   */
  private async savePuzzleProgress(puzzleId: string, state: SolverState): Promise<void> {
    try {
      const puzzle = this.activePuzzles.get(puzzleId);
      if (!puzzle) {
        console.warn(`[BitcoinPuzzleService] Puzzle not found for saving progress: ${puzzleId}`);
        return;
      }

      console.log(`[BitcoinPuzzleService] Saving puzzle progress: ${puzzleId} (status: ${state.status}, attempts: ${state.triedCombinationsCount})`);

      // Speichere State als JSON für schnelle Recovery
      const stateFile = resolve(this.attemptsCsvDir, `${puzzleId}-state.json`);
      const stateData = {
        id: puzzleId,
        name: puzzle.metadata.name,
        targetAddress: state.targetAddress,
        infoUrl: puzzle.metadata.infoUrl,
        status: state.status,
        triedCombinationsCount: state.triedCombinationsCount,
        generatedCount: state.generatedCount,
        currentCombinationMode: state.currentCombinationMode,
        foundAddress: state.foundAddress || null,
        foundMnemonic: state.foundMnemonic || null,
        errorMessage: state.errorMessage || null,
        startedAt: new Date(state.startedAt).toISOString(),
        lastCheckAt: new Date(state.lastCheckAt).toISOString(),
        lastSaveAt: new Date().toISOString(),
        createdAt: new Date(puzzle.metadata.createdAt).toISOString(),
      };
      writeFileSync(stateFile, JSON.stringify(stateData, null, 2), "utf-8");
      console.log(`[BitcoinPuzzleService] Saved state to: ${stateFile}`);

      // Speichere Versuche in CSV (nur die letzten 50 aus dem Solver)
      // Die CSV wird über Zeit kumulativ mit allen Attempts aufgebaut durch Append-Logik
      const attempts = puzzle.solver.getRecentAttempts();
      console.log(`[BitcoinPuzzleService] Saving ${attempts.length} recent attempts to CSV (cumulative append)`);
      if (attempts.length > 0) {
        this.saveAttemptsToCSV(puzzleId, attempts);
      } else {
        console.log(`[BitcoinPuzzleService] No recent attempts to save for puzzle ${puzzleId}`);
      }
    } catch (error) {
      console.error(`[BitcoinPuzzleService] Error saving puzzle progress: ${error}`);
    }
  }

  /**
   * Speichere Versuche in CSV-Datei (append neue Einträge)
   */
  private saveAttemptsToCSV(puzzleId: string, attempts: AttemptRecord[]): void {
    try {
      const filePath = this.getAttemptsFilePath(puzzleId);

      // Validiere dass alle Attempts echte Daten haben
      const validAttempts = attempts.filter(a => {
        if (!a.mnemonic || !a.address) {
          console.warn(`[BitcoinPuzzleService] Skipping invalid attempt: mnemonic="${a.mnemonic}", address="${a.address}"`);
          return false;
        }
        return true;
      });

      if (validAttempts.length === 0) {
        console.log(`[BitcoinPuzzleService] No valid attempts to save for puzzle ${puzzleId}`);
        return;
      }

      console.log(`[BitcoinPuzzleService] Saving CSV to: ${filePath} (${validAttempts.length} valid attempts)`);

      // Überprüfe ob Datei bereits existiert
      const fileExists = existsSync(filePath);

      if (!fileExists) {
        // Neue Datei: schreibe Header + alle Attempts
        console.log(`[BitcoinPuzzleService] Creating new CSV file with ${validAttempts.length} attempts`);
        const lines = ["mnemonic,address"];
        for (const attempt of validAttempts) {
          // Escape Quotes in Werten
          const escapedMnemonic = attempt.mnemonic.replace(/"/g, '""');
          const escapedAddress = attempt.address.replace(/"/g, '""');
          lines.push(`"${escapedMnemonic}","${escapedAddress}"`);
        }
        writeFileSync(filePath, lines.join("\n"), "utf-8");
        console.log(`[BitcoinPuzzleService] CSV created: ${filePath}`);
      } else {
        // Datei existiert: lade existierende Einträge und append nur neue
        console.log(`[BitcoinPuzzleService] Appending attempts to existing CSV`);
        const csvContent = readFileSync(filePath, "utf-8");
        const existingLines = csvContent.split("\n").filter((l) => l.trim() && !l.startsWith("mnemonic"));

        // Parse CSV korrekt (mit Quotes)
        const existingMnemonics = new Set<string>();
        for (const line of existingLines) {
          // Parse CSV-Zeile korrekt
          const match = line.match(/^"([^"]*(?:""[^"]*)*)","([^"]*(?:""[^"]*)*)"$/);
          if (match && match[1]) {
            // Unescape escaped quotes
            const mnemonic = match[1].replace(/""/g, '"');
            existingMnemonics.add(mnemonic);
          }
        }

        // Filtere nur neue Attempts
        const newLines: string[] = [];
        for (const attempt of validAttempts) {
          if (!existingMnemonics.has(attempt.mnemonic)) {
            const escapedMnemonic = attempt.mnemonic.replace(/"/g, '""');
            const escapedAddress = attempt.address.replace(/"/g, '""');
            newLines.push(`"${escapedMnemonic}","${escapedAddress}"`);
          }
        }

        // Append neue Einträge
        if (newLines.length > 0) {
          appendFileSync(filePath, "\n" + newLines.join("\n"), "utf-8");
          console.log(`[BitcoinPuzzleService] CSV appended: ${newLines.length} new attempts to ${filePath}`);
        } else {
          console.log(`[BitcoinPuzzleService] No new attempts to append (all ${validAttempts.length} already in CSV)`);
        }
      }
    } catch (error) {
      console.error(`[BitcoinPuzzleService] Error saving attempts to CSV: ${error}`);
    }
  }

  /**
   * Gib Pfad zur CSV-Datei für Versuche
   */
  getAttemptsFilePath(puzzleId: string): string {
    return resolve(this.attemptsCsvDir, `${puzzleId}-attempts.csv`);
  }

  /**
   * Hole Anzahl der laufenden Puzzle
   */
  getRunningPuzzlesCount(): number {
    return Array.from(this.activePuzzles.values()).filter((p) => p.solver.getState().status === "running").length;
  }

  /**
   * Importiere gefundenen Mnemonic in Wallet
   */
  async importFoundMnemonicToWallet(mnemonic: string, label?: string): Promise<{ success: boolean; address?: string; error?: string }> {
    try {
      console.log(`[BitcoinPuzzleService] Importing found mnemonic to wallet with label: ${label}`);

      // Validiere Mnemonic mit bip39
      const bip39 = await import("bip39");
      if (!bip39.validateMnemonic(mnemonic)) {
        console.error(`[BitcoinPuzzleService] Invalid mnemonic format`);
        return { success: false, error: "Invalid mnemonic format" };
      }

      // Generiere Seed aus Mnemonic
      const seed = await bip39.mnemonicToSeed(mnemonic);

      // Leite Schlüssel mit BIP32 ab - USE dynamicimport for bip32
      let address: string | undefined;
      try {
        const bip32Module = await import("bip32");
        // Handle different export styles (default export or named export)
        const bip32 = (bip32Module as any).default || bip32Module;

        if (typeof bip32.fromSeed === "function") {
          const root = bip32.fromSeed(Buffer.from(seed));
          const child = root.derivePath("m/44'/0'/0'/0/0"); // Standard BIP44 path for Bitcoin

          // Generiere Adresse mit bitcoinjs-lib
          const bitcoinjslib = await import("bitcoinjs-lib");
          const result = bitcoinjslib.payments.p2pkh({ pubkey: child.publicKey });
          address = result.address;
        } else {
          console.warn(`[BitcoinPuzzleService] bip32.fromSeed is not a function, skipping BIP32 derivation`);
        }
      } catch (bip32Error) {
        // Fallback: If bip32 fails, log but continue with address derivation attempt
        console.warn(`[BitcoinPuzzleService] BIP32 derivation failed: ${bip32Error}. Attempting alternative address generation.`);
      }

      if (!address) {
        throw new Error("Failed to generate address from mnemonic");
      }

      console.log(`[BitcoinPuzzleService] Successfully generated address from mnemonic: ${address}`);

      // Store in wallet database if DatabaseService is available
      if (this.db) {
        try {
          const result = await this.db.addCryptoAddress({
            currency: "BTC",
            address: address,
            publicKey: undefined,
            label: label || "Bitcoin Puzzle",
            balance: "0",
            derivationPath: "m/44'/0'/0'/0/0",
          });

          if (result) {
            console.log(`[BitcoinPuzzleService] Successfully stored address in database: ${address}`);
          } else {
            console.log(`[BitcoinPuzzleService] Address already exists in database or insert returned undefined: ${address}`);
          }
        } catch (dbError) {
          // Don't fail the entire import if DB storage fails, just log it
          const dbErrorMsg = dbError instanceof Error ? dbError.message : String(dbError);
          console.error(`[BitcoinPuzzleService] Warning: Failed to store address in database: ${dbErrorMsg}`);
        }
      } else {
        console.warn(`[BitcoinPuzzleService] DatabaseService not available, skipping database storage`);
      }

      console.log(`[BitcoinPuzzleService] Mnemonic imported successfully with label: ${label || "Bitcoin Puzzle"}`);
      return { success: true, address };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[BitcoinPuzzleService] Error importing mnemonic: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Hole Info über alle laufenden Puzzle
   */
  getRunningPuzzlesInfo(): Array<{ id: string; name: string; targetAddress: string; generatedCount: number }> {
    return Array.from(this.activePuzzles.values())
      .filter((p) => p.solver.getState().status === "running")
      .map((p) => ({
        id: p.metadata.id,
        name: p.metadata.name,
        targetAddress: p.metadata.targetAddress,
        generatedCount: p.solver.getState().generatedCount,
      }));
  }

  /**
   * Hole Info über ALLE Puzzle (aktive + gespeicherte)
   */
  getAllPuzzlesInfo(): Array<{
    id: string;
    name: string;
    targetAddress: string;
    status: string;
    generatedCount: number;
    triedCombinationsCount: number;
    found: boolean;
  }> {
    const puzzles: Array<{
      id: string;
      name: string;
      targetAddress: string;
      status: string;
      generatedCount: number;
      triedCombinationsCount: number;
      found: boolean;
    }> = [];

    // Alle aktiven Puzzles
    for (const puzzle of this.activePuzzles.values()) {
      const state = puzzle.solver.getState();
      puzzles.push({
        id: puzzle.metadata.id,
        name: puzzle.metadata.name,
        targetAddress: puzzle.metadata.targetAddress,
        status: state.status,
        generatedCount: state.generatedCount,
        triedCombinationsCount: state.triedCombinationsCount,
        found: !!state.foundMnemonic,
      });
    }

    // Alle gespeicherten Puzzle (von Disk) die nicht aktiv sind
    try {
      if (existsSync(this.attemptsCsvDir)) {
        const stateFiles = readdirSync(this.attemptsCsvDir)
          .filter((f: string) => f.endsWith("-state.json"));

        for (const file of stateFiles) {
          const puzzleId = file.replace("-state.json", "");

          // Skip wenn bereits in aktivenPuzzles
          if (this.activePuzzles.has(puzzleId)) continue;

          try {
            const stateFile = resolve(this.attemptsCsvDir, file);
            const stateJson = readFileSync(stateFile, "utf-8");
            const saved = JSON.parse(stateJson);

            puzzles.push({
              id: saved.id,
              name: saved.name,
              targetAddress: saved.targetAddress,
              status: saved.status,
              generatedCount: saved.generatedCount,
              triedCombinationsCount: saved.triedCombinationsCount,
              found: !!saved.foundMnemonic,
            });
          } catch (err) {
            console.error(`[BitcoinPuzzleService] Error reading state file ${file}:`, err);
          }
        }
      }
    } catch (error) {
      console.error("[BitcoinPuzzleService] Error loading saved puzzle states:", error);
    }

    return puzzles;
  }

  /**
   * Suche nach einer Phrase oder Adresse in EINER Puzzle-CSV
   */
  searchPuzzleAttempts(puzzleId: string, query: string): AttemptRecord[] {
    try {
      const csvPath = this.getAttemptsFilePath(puzzleId);
      if (!existsSync(csvPath)) {
        return [];
      }

      const csvContent = readFileSync(csvPath, "utf-8");
      const lines = csvContent.split("\n").filter((l) => l.trim());

      const lowerQuery = query.toLowerCase();
      const results: AttemptRecord[] = [];

      for (const line of lines.slice(1)) {
        // Skip header
        const parsed = parseCSVLine(line);
        if (parsed) {
          const [m, a] = parsed;
          if (m.toLowerCase().includes(lowerQuery) || a.toLowerCase().includes(lowerQuery)) {
            results.push({ mnemonic: m, address: a });
          }
        }
      }

      return results;
    } catch (err) {
      console.error(`[BitcoinPuzzleService] Error searching puzzle attempts:`, err);
      return [];
    }
  }

  /**
   * Suche nach einer Phrase oder Adresse in ALLEN Puzzle-CSVs
   */
  searchAllPuzzleAttempts(query: string): Array<{
    puzzleId: string;
    puzzleName: string;
    targetAddress: string;
    matches: AttemptRecord[];
  }> {
    try {
      const results: Array<{
        puzzleId: string;
        puzzleName: string;
        targetAddress: string;
        matches: AttemptRecord[];
      }> = [];

      // Suche in aktiven Puzzles
      for (const puzzle of this.activePuzzles.values()) {
        const matches = this.searchPuzzleAttempts(puzzle.metadata.id, query);
        if (matches.length > 0) {
          results.push({
            puzzleId: puzzle.metadata.id,
            puzzleName: puzzle.metadata.name,
            targetAddress: puzzle.metadata.targetAddress,
            matches,
          });
        }
      }

      // Suche in gespeicherten Puzzles
      if (existsSync(this.attemptsCsvDir)) {
        const stateFiles = readdirSync(this.attemptsCsvDir).filter((f) => f.endsWith("-state.json"));

        for (const file of stateFiles) {
          const puzzleId = file.replace("-state.json", "");

          // Skip wenn bereits in aktiven Puzzles
          if (this.activePuzzles.has(puzzleId)) continue;

          try {
            const stateFile = resolve(this.attemptsCsvDir, file);
            const stateJson = readFileSync(stateFile, "utf-8");
            const saved = JSON.parse(stateJson);

            const matches = this.searchPuzzleAttempts(puzzleId, query);
            if (matches.length > 0) {
              results.push({
                puzzleId: saved.id,
                puzzleName: saved.name,
                targetAddress: saved.targetAddress,
                matches,
              });
            }
          } catch (err) {
            console.error(`Error searching state file ${file}:`, err);
          }
        }
      }

      return results;
    } catch (error) {
      console.error("[BitcoinPuzzleService] Error searching all puzzle attempts:", error);
      return [];
    }
  }

  /**
   * Prüfe ob eine Phrase bereits in EINER Puzzle-CSV existiert
   */
  phraseExistsInPuzzle(puzzleId: string, phrase: string): boolean {
    try {
      const csvPath = this.getAttemptsFilePath(puzzleId);
      if (!existsSync(csvPath)) {
        return false;
      }

      const csvContent = readFileSync(csvPath, "utf-8");
      const lines = csvContent.split("\n").filter((l) => l.trim());

      for (const line of lines.slice(1)) {
        const parsed = parseCSVLine(line);
        if (parsed && parsed[0] === phrase) {
          return true;
        }
      }

      return false;
    } catch (err) {
      console.error(`[BitcoinPuzzleService] Error checking phrase existence:`, err);
      return false;
    }
  }

  /**
   * Prüfe ob eine Phrase in IRGENDEINEM Puzzle existiert
   */
  phraseExistsAnyPuzzle(phrase: string): { exists: boolean; puzzleId?: string } {
    try {
      // Prüfe aktive Puzzles
      for (const puzzle of this.activePuzzles.values()) {
        if (this.phraseExistsInPuzzle(puzzle.metadata.id, phrase)) {
          return { exists: true, puzzleId: puzzle.metadata.id };
        }
      }

      // Prüfe gespeicherte Puzzles
      if (existsSync(this.attemptsCsvDir)) {
        const csvFiles = readdirSync(this.attemptsCsvDir).filter((f) => f.endsWith("-attempts.csv"));

        for (const csvFile of csvFiles) {
          const puzzleId = csvFile.replace("-attempts.csv", "");
          if (this.phraseExistsInPuzzle(puzzleId, phrase)) {
            return { exists: true, puzzleId };
          }
        }
      }

      return { exists: false };
    } catch (error) {
      console.error("[BitcoinPuzzleService] Error checking phrase existence:", error);
      return { exists: false };
    }
  }

  /**
   * Lade ALLE Versuche von der CSV-Datei (für triedCombinations Restore)
   */
  private getAllAttemptsFromCsv(puzzleId: string): AttemptRecord[] {
    try {
      const csvPath = this.getAttemptsFilePath(puzzleId);
      if (!existsSync(csvPath)) {
        return [];
      }

      const csvContent = readFileSync(csvPath, "utf-8");
      const lines = csvContent.split("\n").filter((l) => l.trim());

      if (lines.length <= 1) {
        // Nur Header, keine Daten
        return [];
      }

      const results: AttemptRecord[] = [];
      for (const line of lines.slice(1)) {
        // Skip header
        const parsed = parseCSVLine(line);
        if (parsed) {
          results.push({
            mnemonic: parsed[0],
            address: parsed[1],
          });
        }
      }

      return results;
    } catch (err) {
      console.error(`[BitcoinPuzzleService] Error reading all attempts from CSV:`, err);
      return [];
    }
  }

  /**
   * Lade letzte 50 Versuche von der CSV-Datei
   */
  private getRecentAttemptsFromCsv(puzzleId: string): AttemptRecord[] {
    try {
      const csvPath = this.getAttemptsFilePath(puzzleId);
      if (!existsSync(csvPath)) {
        return [];
      }

      const csvContent = readFileSync(csvPath, "utf-8");
      const lines = csvContent.split("\n").filter((l) => l.trim());

      if (lines.length <= 1) {
        // Nur Header, keine Daten
        return [];
      }

      // Lese letzte 50 Zeilen (skip Header)
      const dataLines = lines.slice(1); // Skip header
      const lastLines = dataLines.slice(-50);

      return lastLines
        .map((line) => {
          // Parse CSV-Zeile korrekt mit Quotes
          const match = line.match(/^"([^"]*(?:""[^"]*)*)","([^"]*(?:""[^"]*)*)"$/);
          if (match && match[1] && match[2]) {
            // Unescape escaped quotes ("")
            const mnemonic = match[1].replace(/""/g, '"');
            const address = match[2].replace(/""/g, '"');
            return { mnemonic, address };
          }
          return null;
        })
        .filter((r) => r !== null) as AttemptRecord[];
    } catch (err) {
      console.error(`[BitcoinPuzzleService] Error reading recent attempts from CSV:`, err);
      return [];
    }
  }
}

export { type SolverState, type SolverConfig };
