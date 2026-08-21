/**
 * Bitcoin puzzle solver module tool (trust: "node"). Ported from the former core-app
 * BitcoinPuzzleService/BitcoinPuzzleRouter (packages/agent/src/crypto/, apps/server/src/routes/
 * bitcoin-puzzle.ts) so this feature is agent-tool-driven instead of living only behind a
 * bespoke React page and a deprecated tool stub.
 *
 * Storage stays FLAT FILES on purpose (not plugin SQLite): one JSON state file + one append-only
 * CSV of every tried mnemonic/address pair per puzzle, exactly the original format. By default it
 * points at the SAME directory the core feature used
 * (`${SHARED_WORKSPACE_PATH}/bitcoin-puzzle-attempts`) so puzzles created before this migration
 * (including a puzzle with 7M+ tried combinations) keep working with zero data migration - the
 * plugin just starts operating on the existing files in place. Override via the `attempts_dir`/
 * `wordlist_path` settings if needed.
 *
 * The old core route (apps/server/src/routes/bitcoin-puzzle.ts) is unmounted once this plugin is
 * verified working, so only one engine ever touches these files at a time.
 *
 * Three search modes (see solver.js for the actual generation logic): "random" (default),
 * "sequential" (systematic 128-bit entropy walk, resumable via a persisted counter), and
 * "partial" (exhaustively try every substitution for 1-2 unknown words in a known phrase -
 * a finite space, can run out and report "exhausted").
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  appendFileSync,
  unlinkSync,
  createReadStream,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { BitcoinPuzzleSolver } from "./solver.js";

export const definition = {
  name: "bitcoin_puzzle",
  description:
    "Bitcoin-Puzzle-Solver: leitet aus 12-Wort-BIP39-Mnemonics eine P2PKH-Adresse ab und vergleicht sie mit einer Zieladresse. Drei Suchmodi (mode bei create): " +
    "'random' (Standard, zufällige Mnemonics), 'sequential' (systematischer, lückenloser Durchlauf durch den gesamten 128-Bit-Entropieraum, resumable), " +
    "'partial' (nur bekannte Wörter + 1-2 Lücken (__/?) im template werden erschöpfend durchprobiert - endlicher, viel kleinerer Suchraum). " +
    "action=create (targetAddress, name?, infoUrl?, mode?, template? für partial)/list/get (puzzleId)/pause/resume/stop/delete/update (puzzleId, name?, infoUrl?). " +
    "action=mark_phrase (puzzleId, phrase, address?) markiert eine Phrase als bereits versucht (unterstützt __/? als Platzhalter, max. 2, generiert alle Kombinationen). " +
    "action=search (puzzleId, query)/search_all (query)/check_phrase (phrase) durchsuchen die Versuchsprotokolle. " +
    "action=list_attempts (puzzleId, offset?, limit?) blättert roh durch die CSV-Versuchsdatei (Ansicht, kein Suchbegriff nötig). " +
    "action=mark_found (puzzleId, mnemonic) prüft eine vollständige Mnemonic gegen die Zieladresse und markiert das Puzzle bei Treffer als gelöst.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "list", "get", "pause", "resume", "stop", "delete", "update", "mark_phrase", "search", "search_all", "check_phrase", "mark_found", "list_attempts"],
      },
      puzzleId: { type: "string", description: "Ziel-Puzzle (alle außer create/list/search_all/check_phrase)" },
      targetAddress: { type: "string", description: "Bitcoin-Zieladresse (create)" },
      name: { type: "string", description: "Anzeigename (create/update)" },
      infoUrl: { type: "string", description: "Optionale Info-URL zum Puzzle (create/update)" },
      mode: { type: "string", enum: ["random", "sequential", "partial"], description: "Suchmodus (create, Standard random)" },
      template: { type: "string", description: "Phrase mit 1-2 Lücken (__ oder ?) für mode=partial, z. B. 'abandon ability __ actual admit adult advance afraid again age agent about'" },
      phrase: { type: "string", description: "Phrase, ggf. mit __ oder ? als Platzhalter für fehlende Wörter (mark_phrase)" },
      mnemonic: { type: "string", description: "Vollständige 12-Wort-Mnemonic (mark_found)" },
      address: { type: "string", description: "Zugehörige Adresse, falls bekannt (mark_phrase)" },
      query: { type: "string", description: "Suchbegriff (search/search_all/check_phrase)" },
      offset: { type: "number", description: "Anzahl zu überspringender Zeilen (list_attempts, Standard 0)" },
      limit: { type: "number", description: "Anzahl Zeilen (list_attempts, Standard 100, max. 500)" },
    },
    required: ["action"],
  },
};

/** Deterministic id from the target address, so the same puzzle always gets the same id. */
function deterministicId(targetAddress) {
  const hash = createHash("sha256").update(targetAddress).digest("hex");
  return `puzzle-${hash.substring(0, 12)}`;
}

function parseCSVLine(line) {
  const match = line.match(/^"([^"]*(?:""[^"]*)*)","([^"]*(?:""[^"]*)*)"$/);
  if (match && match[1] !== undefined && match[2] !== undefined) {
    return [match[1].replace(/""/g, '"'), match[2].replace(/""/g, '"')];
  }
  return null;
}

/** All combinations for a partial mnemonic like "word1 word2 __ word4" (max 2 missing words). */
function generatePartialMnemonicCombinations(partialPhrase, wordList) {
  const words = partialPhrase.split(/\s+/).filter((w) => w.trim());
  const missingPositions = [];
  words.forEach((word, idx) => {
    if (!word || word === "__" || word === "?") missingPositions.push(idx);
  });
  if (missingPositions.length === 0) return [partialPhrase];
  if (missingPositions.length > 2) return [];

  const totalCombinations = Math.pow(wordList.length, missingPositions.length);
  if (totalCombinations > 1_000_000) return [];

  const combinations = [];
  const generateRecursive = (posIdx, currentWords) => {
    if (posIdx === missingPositions.length) {
      combinations.push(currentWords.join(" "));
      return;
    }
    const position = missingPositions[posIdx];
    for (const word of wordList) {
      const newWords = [...currentWords];
      newWords[position] = word;
      generateRecursive(posIdx + 1, newWords);
    }
  };
  generateRecursive(0, words.slice());
  return combinations;
}

// ---------------------------------------------------------------------------------------------
// Module-level singleton state - same lifetime/scope as the original class's static instance,
// since this module is only ever imported once per server process.
// ---------------------------------------------------------------------------------------------

let initialized = false;
let wordList = [];
let attemptsDir = "";
/** puzzleId -> { metadata: {id,name,targetAddress,infoUrl,createdAt}, solver, promise } */
const activePuzzles = new Map();
/** puzzleId -> Set of already-persisted mnemonics (lazily built in the background). */
const persistedMnemonics = new Map();
const persistedIndexBuilds = new Map();

function ensureInit(ctx) {
  if (initialized) return;
  initialized = true;

  const sharedWorkspace = process.env["SHARED_WORKSPACE_PATH"] ?? "./shared-workspace";
  attemptsDir = String(ctx.settings.attempts_dir || "").trim() || resolve(sharedWorkspace, "bitcoin-puzzle-attempts");
  if (!existsSync(attemptsDir)) mkdirSync(attemptsDir, { recursive: true });

  const wordlistPath = String(ctx.settings.wordlist_path || "").trim() || resolve(sharedWorkspace, "btc-puzzle", "english.txt");
  try {
    const content = readFileSync(wordlistPath, "utf-8");
    wordList = content.split("\n").filter((w) => w.trim().length > 0);
    ctx.logger?.debug?.(`Loaded ${wordList.length} BIP39 words from ${wordlistPath}`);
  } catch (error) {
    ctx.logger?.warn?.("Failed to load BIP39 word list", { wordlistPath, error: error instanceof Error ? error.message : String(error) });
    wordList = [];
  }

  // Restore every saved puzzle state (does NOT start any solver loop - just makes it visible
  // and resumable), same as the original service's initializeFromDatabase().
  try {
    const stateFiles = readdirSync(attemptsDir).filter((f) => f.endsWith("-state.json"));
    for (const file of stateFiles) restorePuzzleFromDisk(file.replace("-state.json", ""), ctx);
    ctx.logger?.debug?.(`Restored ${activePuzzles.size} puzzle state(s) from ${attemptsDir}`);
  } catch (error) {
    ctx.logger?.warn?.("Failed to restore puzzle states", { error: error instanceof Error ? error.message : String(error) });
  }
}

function attemptsFilePath(puzzleId) {
  return resolve(attemptsDir, `${puzzleId}-attempts.csv`);
}
function stateFilePath(puzzleId) {
  return resolve(attemptsDir, `${puzzleId}-state.json`);
}

function getPersistedMnemonics(puzzleId, ctx) {
  let set = persistedMnemonics.get(puzzleId);
  if (!set) {
    set = new Set();
    persistedMnemonics.set(puzzleId, set);
    ensurePersistedIndex(puzzleId, ctx).catch((err) => ctx.logger?.warn?.("background index build failed", { puzzleId, error: String(err) }));
  }
  return set;
}

/** Streams a puzzle's CSV line by line (never readFileSync - files can exceed 800MB). */
async function streamAttempts(puzzleId, onAttempt) {
  const csvPath = attemptsFilePath(puzzleId);
  if (!existsSync(csvPath)) return 0;
  const stream = createReadStream(csvPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  let firstLine = true;
  try {
    for await (const line of rl) {
      if (firstLine) { firstLine = false; continue; } // header row
      if (!line.trim()) continue;
      const parsed = parseCSVLine(line);
      if (!parsed) continue;
      count++;
      if (onAttempt({ mnemonic: parsed[0], address: parsed[1] }) === true) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return count;
}

function ensurePersistedIndex(puzzleId, ctx) {
  const existing = persistedIndexBuilds.get(puzzleId);
  if (existing) return existing;
  const build = (async () => {
    const set = persistedMnemonics.get(puzzleId) ?? new Set();
    persistedMnemonics.set(puzzleId, set);
    try {
      const count = await streamAttempts(puzzleId, (attempt) => { set.add(attempt.mnemonic); });
      const puzzle = activePuzzles.get(puzzleId);
      if (puzzle) puzzle.solver.raiseTriedCombinationsCount(set.size);
      ctx.logger?.debug?.(`Indexed ${set.size} persisted attempts for ${puzzleId} (${count} rows read)`);
    } catch (err) {
      ctx.logger?.warn?.("error building persisted index", { puzzleId, error: String(err) });
    }
  })();
  persistedIndexBuilds.set(puzzleId, build);
  return build;
}

/** Reads only the last ~128KB of a CSV for a bounded "recent attempts" window - safe for 800MB files. */
function tailRecentAttempts(puzzleId, count) {
  try {
    const csvPath = attemptsFilePath(puzzleId);
    if (!existsSync(csvPath)) return [];
    const size = statSync(csvPath).size;
    if (size <= 0) return [];
    const TAIL_BYTES = 128 * 1024;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = openSync(csvPath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n").filter((l) => l.trim());
      const results = [];
      for (const line of lines.slice(1)) { // first line may start mid-row
        const parsed = parseCSVLine(line);
        if (parsed) results.push({ mnemonic: parsed[0], address: parsed[1] });
      }
      return results.slice(-count);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

function saveAttemptsToCSV(puzzleId, attempts, ctx) {
  const validAttempts = attempts.filter((a) => a.mnemonic);
  if (validAttempts.length === 0) return;

  const persisted = getPersistedMnemonics(puzzleId, ctx);
  const filePath = attemptsFilePath(puzzleId);
  const fileExists = existsSync(filePath);

  const newLines = [];
  for (const attempt of validAttempts) {
    if (persisted.has(attempt.mnemonic)) continue;
    persisted.add(attempt.mnemonic);
    const escapedMnemonic = attempt.mnemonic.replace(/"/g, '""');
    const escapedAddress = (attempt.address || "").replace(/"/g, '""');
    newLines.push(`"${escapedMnemonic}","${escapedAddress}"`);
  }
  if (newLines.length === 0) return;

  if (!fileExists) {
    writeFileSync(filePath, ["mnemonic,address", ...newLines].join("\n"), "utf-8");
  } else {
    appendFileSync(filePath, "\n" + newLines.join("\n"), "utf-8");
  }
}

async function savePuzzleProgress(puzzleId, state, ctx) {
  const puzzle = activePuzzles.get(puzzleId);
  if (!puzzle) return;

  const stateData = {
    id: puzzleId,
    name: puzzle.metadata.name,
    targetAddress: state.targetAddress,
    infoUrl: puzzle.metadata.infoUrl,
    status: state.status,
    triedCombinationsCount: state.triedCombinationsCount,
    generatedCount: state.generatedCount,
    currentCombinationMode: state.currentCombinationMode,
    mode: puzzle.solver.mode,
    template: puzzle.solver.template || null,
    sequentialCounterHex: puzzle.solver.mode === "sequential" ? puzzle.solver.getSequentialCounterHex() : null,
    combinationIndex: puzzle.solver.mode === "partial" ? puzzle.solver.getCombinationIndex() : null,
    foundAddress: state.foundAddress || null,
    foundMnemonic: state.foundMnemonic || null,
    errorMessage: state.errorMessage || null,
    startedAt: new Date(state.startedAt).toISOString(),
    lastCheckAt: new Date(state.lastCheckAt).toISOString(),
    lastSaveAt: new Date().toISOString(),
    createdAt: new Date(puzzle.metadata.createdAt).toISOString(),
  };
  writeFileSync(stateFilePath(puzzleId), JSON.stringify(stateData, null, 2), "utf-8");

  const attempts = puzzle.solver.drainPendingAttempts();
  if (attempts.length > 0) saveAttemptsToCSV(puzzleId, attempts, ctx);
}

function restorePuzzleFromDisk(puzzleId, ctx) {
  const existing = activePuzzles.get(puzzleId);
  if (existing) return existing;

  const file = stateFilePath(puzzleId);
  if (!existsSync(file)) return null;

  try {
    const saved = JSON.parse(readFileSync(file, "utf-8"));
    const mode = saved.mode || "random";
    // "partial" mode's combinations array is never persisted (can be up to 1M entries) - cheap
    // to regenerate deterministically from the saved template instead.
    const combinations = mode === "partial" && saved.template ? generatePartialMnemonicCombinations(saved.template, wordList) : undefined;
    const solver = new BitcoinPuzzleSolver(wordList, {
      targetAddress: saved.targetAddress,
      mode,
      template: saved.template || undefined,
      combinations,
      combinationIndex: saved.combinationIndex || 0,
      sequentialCounterHex: saved.sequentialCounterHex || undefined,
    });
    solver.restoreState({
      triedCombinationsCount: saved.triedCombinationsCount,
      generatedCount: saved.generatedCount,
      currentCombinationMode: saved.currentCombinationMode,
      status: saved.status,
      startedAt: new Date(saved.startedAt).getTime(),
      lastCheckAt: new Date(saved.lastCheckAt).getTime(),
      foundMnemonic: saved.foundMnemonic || undefined,
      foundAddress: saved.foundAddress || undefined,
      errorMessage: saved.errorMessage || undefined,
    });

    solver.setRecentAttempts(tailRecentAttempts(puzzleId, 50));
    ensurePersistedIndex(puzzleId, ctx).catch(() => {});
    solver.setPhraseExistsCallback((phrase) => getPersistedMnemonics(puzzleId, ctx).has(phrase));

    const metadata = { id: saved.id ?? puzzleId, name: saved.name, targetAddress: saved.targetAddress, infoUrl: saved.infoUrl, createdAt: new Date(saved.createdAt).getTime() };
    const puzzle = { metadata, solver, promise: null };
    activePuzzles.set(metadata.id, puzzle);
    return puzzle;
  } catch (err) {
    ctx.logger?.warn?.("error restoring puzzle", { puzzleId, error: String(err) });
    return null;
  }
}

function getPuzzleInfo(puzzleId, ctx) {
  const puzzle = activePuzzles.get(puzzleId) ?? restorePuzzleFromDisk(puzzleId, ctx);
  if (!puzzle) return null;
  const state = puzzle.solver.getState();
  return {
    id: puzzle.metadata.id,
    name: puzzle.metadata.name,
    targetAddress: puzzle.metadata.targetAddress,
    infoUrl: puzzle.metadata.infoUrl,
    createdAt: puzzle.metadata.createdAt,
    mode: puzzle.solver.mode,
    template: puzzle.solver.template || null,
    combinationProgress: puzzle.solver.getCombinationProgress(),
    state,
    isRunning: state.status === "running" && puzzle.solver.isLoopAlive(),
    elapsedSeconds: puzzle.solver.getRunElapsedSeconds(),
    addressesPerSecond: puzzle.solver.getRatePerSecond(),
    recentAttempts: puzzle.solver.getRecentAttempts(),
  };
}

function getAllPuzzlesInfo(ctx) {
  const puzzles = [];
  for (const puzzle of activePuzzles.values()) {
    const state = puzzle.solver.getState();
    puzzles.push({
      id: puzzle.metadata.id, name: puzzle.metadata.name, targetAddress: puzzle.metadata.targetAddress,
      status: state.status, generatedCount: state.generatedCount, triedCombinationsCount: state.triedCombinationsCount,
      found: !!state.foundMnemonic, isRunning: state.status === "running" && puzzle.solver.isLoopAlive(),
      addressesPerSecond: puzzle.solver.getRatePerSecond(),
      mode: puzzle.solver.mode, combinationProgress: puzzle.solver.getCombinationProgress(),
    });
  }
  // Any saved-but-not-yet-restored puzzles (shouldn't normally happen since ensureInit restores
  // everything up front, but stays correct if a state file appears later).
  try {
    for (const file of readdirSync(attemptsDir).filter((f) => f.endsWith("-state.json"))) {
      const puzzleId = file.replace("-state.json", "");
      if (activePuzzles.has(puzzleId)) continue;
      const saved = JSON.parse(readFileSync(resolve(attemptsDir, file), "utf-8"));
      puzzles.push({
        id: saved.id, name: saved.name, targetAddress: saved.targetAddress, status: saved.status,
        generatedCount: saved.generatedCount, triedCombinationsCount: saved.triedCombinationsCount,
        found: !!saved.foundMnemonic, isRunning: false, addressesPerSecond: 0,
        mode: saved.mode || "random", combinationProgress: null,
      });
    }
  } catch { /* attemptsDir listing is best-effort */ }
  return puzzles;
}

export async function execute(input, ctx) {
  ensureInit(ctx);

  if (input.action === "create") {
    if (!input.targetAddress) return { error: "targetAddress ist erforderlich" };
    if (wordList.length === 0) return { error: "BIP39-Wortliste konnte nicht geladen werden" };

    const puzzleId = deterministicId(input.targetAddress);
    const existing = activePuzzles.get(puzzleId);
    if (existing && existing.solver.getState().status === "running") {
      return { id: puzzleId, alreadyRunning: true, ...getPuzzleInfo(puzzleId, ctx) };
    }

    const mode = input.mode || "random";
    let combinations;
    if (mode === "partial") {
      if (!input.template) return { error: "template ist erforderlich für mode=partial" };
      combinations = generatePartialMnemonicCombinations(input.template, wordList);
      if (combinations.length === 0) {
        return { error: "Konnte keine Kombinationen aus template generieren (max. 2 Lücken, max. 1 Mio. Kombinationen)" };
      }
    }

    const metadata = { id: puzzleId, name: input.name || `Puzzle ${new Date().toLocaleString()}`, targetAddress: input.targetAddress, infoUrl: input.infoUrl, createdAt: Date.now() };
    const solver = new BitcoinPuzzleSolver(wordList, { targetAddress: input.targetAddress, mode, template: input.template, combinations });
    solver.setPhraseExistsCallback((phrase) => getPersistedMnemonics(puzzleId, ctx).has(phrase));

    const promise = solver.start((state) => { savePuzzleProgress(puzzleId, state, ctx).catch(() => {}); })
      .catch((error) => { ctx.logger?.warn?.("solver loop error", { puzzleId, error: String(error) }); return solver.getState(); });

    activePuzzles.set(puzzleId, { metadata, solver, promise });
    await savePuzzleProgress(puzzleId, solver.getState(), ctx);

    // Check whether the target address already shows up in any existing puzzle's log.
    let foundMnemonic = null;
    for (const csvFile of readdirSync(attemptsDir).filter((f) => f.endsWith("-attempts.csv"))) {
      const otherId = csvFile.replace("-attempts.csv", "");
      let hit = null;
      await streamAttempts(otherId, (a) => { if (a.address === input.targetAddress) { hit = a.mnemonic; return true; } });
      if (hit) { foundMnemonic = hit; break; }
    }
    if (foundMnemonic) {
      const solvedState = solver.getState();
      solvedState.status = "completed";
      solvedState.foundMnemonic = foundMnemonic;
      solvedState.foundAddress = input.targetAddress;
      solver.stop();
      await savePuzzleProgress(puzzleId, solvedState, ctx);
      return { id: puzzleId, foundInExistingLog: true, ...getPuzzleInfo(puzzleId, ctx) };
    }

    return { id: puzzleId, ...getPuzzleInfo(puzzleId, ctx) };
  }

  if (input.action === "list") {
    return { count: activePuzzles.size, puzzles: getAllPuzzlesInfo(ctx) };
  }

  if (input.action === "get") {
    if (!input.puzzleId) return { error: "puzzleId ist erforderlich" };
    const info = getPuzzleInfo(input.puzzleId, ctx);
    if (!info) return { error: "Puzzle nicht gefunden" };
    return info;
  }

  if (input.action === "pause") {
    if (!input.puzzleId) return { error: "puzzleId ist erforderlich" };
    const puzzle = activePuzzles.get(input.puzzleId);
    if (!puzzle) return { error: "Puzzle nicht gefunden oder nicht aktiv" };
    puzzle.solver.pause();
    await savePuzzleProgress(input.puzzleId, puzzle.solver.getState(), ctx);
    return getPuzzleInfo(input.puzzleId, ctx);
  }

  if (input.action === "resume") {
    if (!input.puzzleId) return { error: "puzzleId ist erforderlich" };
    const puzzle = activePuzzles.get(input.puzzleId) ?? restorePuzzleFromDisk(input.puzzleId, ctx);
    if (!puzzle) return { error: "Puzzle nicht gefunden" };
    const current = puzzle.solver.getState();
    if (current.status === "completed" || current.foundMnemonic) return getPuzzleInfo(input.puzzleId, ctx);

    puzzle.solver.resume();
    if (!puzzle.solver.isLoopAlive()) {
      const promise = puzzle.solver.start((state) => { savePuzzleProgress(input.puzzleId, state, ctx).catch(() => {}); });
      promise.catch((error) => ctx.logger?.warn?.("solver loop error", { puzzleId: input.puzzleId, error: String(error) }));
      puzzle.promise = promise;
    }
    return getPuzzleInfo(input.puzzleId, ctx);
  }

  if (input.action === "stop") {
    if (!input.puzzleId) return { error: "puzzleId ist erforderlich" };
    const puzzle = activePuzzles.get(input.puzzleId);
    if (!puzzle) return { error: "Puzzle nicht gefunden oder nicht aktiv" };
    puzzle.solver.stop();
    puzzle.promise = null;
    await savePuzzleProgress(input.puzzleId, puzzle.solver.getState(), ctx);
    return getPuzzleInfo(input.puzzleId, ctx);
  }

  if (input.action === "delete") {
    if (!input.puzzleId) return { error: "puzzleId ist erforderlich" };
    let deletedAny = false;
    const puzzle = activePuzzles.get(input.puzzleId);
    if (puzzle) { puzzle.solver.stop(); activePuzzles.delete(input.puzzleId); deletedAny = true; }
    if (existsSync(stateFilePath(input.puzzleId))) { unlinkSync(stateFilePath(input.puzzleId)); deletedAny = true; }
    if (existsSync(attemptsFilePath(input.puzzleId))) { unlinkSync(attemptsFilePath(input.puzzleId)); deletedAny = true; }
    persistedMnemonics.delete(input.puzzleId);
    persistedIndexBuilds.delete(input.puzzleId);
    return { ok: deletedAny };
  }

  if (input.action === "update") {
    if (!input.puzzleId) return { error: "puzzleId ist erforderlich" };
    const puzzle = activePuzzles.get(input.puzzleId) ?? restorePuzzleFromDisk(input.puzzleId, ctx);
    if (!puzzle) return { error: "Puzzle nicht gefunden" };
    if (input.name !== undefined) puzzle.metadata.name = input.name;
    if (input.infoUrl !== undefined) puzzle.metadata.infoUrl = input.infoUrl;
    await savePuzzleProgress(input.puzzleId, puzzle.solver.getState(), ctx);
    return getPuzzleInfo(input.puzzleId, ctx);
  }

  if (input.action === "mark_phrase") {
    if (!input.puzzleId || !input.phrase) return { error: "puzzleId und phrase sind erforderlich" };
    const phraseStr = input.phrase.trim();

    if (phraseStr.includes("__") || phraseStr.includes("?")) {
      const combinations = generatePartialMnemonicCombinations(phraseStr, wordList);
      if (combinations.length === 0) return { error: "Konnte Kombinationen nicht generieren (max. 2 fehlende Wörter)" };
      const attempts = combinations.map((combo) => ({ mnemonic: combo, address: "" }));
      saveAttemptsToCSV(input.puzzleId, attempts, ctx);
      activePuzzles.get(input.puzzleId)?.solver.setTriedCombinations(attempts);
      return { ok: true, generatedCount: attempts.length };
    }

    saveAttemptsToCSV(input.puzzleId, [{ mnemonic: phraseStr, address: input.address || "" }], ctx);
    const puzzle = activePuzzles.get(input.puzzleId);
    if (puzzle) {
      puzzle.solver.setTriedCombinations([{ mnemonic: phraseStr, address: input.address || "" }]);
      if (input.address && input.address === puzzle.metadata.targetAddress) {
        const state = puzzle.solver.getState();
        state.status = "completed";
        state.foundMnemonic = phraseStr;
        state.foundAddress = input.address;
        await savePuzzleProgress(input.puzzleId, state, ctx);
      }
    }
    return { ok: true, generatedCount: 1 };
  }

  if (input.action === "mark_found") {
    if (!input.puzzleId || !input.mnemonic) return { error: "puzzleId und mnemonic sind erforderlich" };
    const puzzle = activePuzzles.get(input.puzzleId) ?? restorePuzzleFromDisk(input.puzzleId, ctx);
    if (!puzzle) return { error: "Puzzle nicht gefunden" };
    const solverForDerivation = new BitcoinPuzzleSolver(wordList, { targetAddress: puzzle.metadata.targetAddress });
    let address;
    try {
      address = solverForDerivation.generateAddressFromMnemonic(input.mnemonic.trim());
    } catch (error) {
      return { error: `Adressableitung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}` };
    }
    const matches = address === puzzle.metadata.targetAddress;
    if (matches) {
      puzzle.solver.stop();
      const state = puzzle.solver.getState();
      state.status = "completed";
      state.foundMnemonic = input.mnemonic.trim();
      state.foundAddress = address;
      await savePuzzleProgress(input.puzzleId, state, ctx);
    }
    return { matches, derivedAddress: address, targetAddress: puzzle.metadata.targetAddress };
  }

  if (input.action === "search") {
    if (!input.puzzleId || !input.query) return { error: "puzzleId und query sind erforderlich" };
    const lowerQuery = input.query.toLowerCase();
    const results = [];
    const MAX_RESULTS = 1000;
    await streamAttempts(input.puzzleId, (a) => {
      if (a.mnemonic.toLowerCase().includes(lowerQuery) || a.address.toLowerCase().includes(lowerQuery)) results.push(a);
      return results.length >= MAX_RESULTS;
    });
    return { count: results.length, matches: results };
  }

  if (input.action === "search_all") {
    if (!input.query) return { error: "query ist erforderlich" };
    const lowerQuery = input.query.toLowerCase();
    const results = [];
    const puzzleIds = new Set([...activePuzzles.keys(), ...readdirSync(attemptsDir).filter((f) => f.endsWith("-attempts.csv")).map((f) => f.replace("-attempts.csv", ""))]);
    for (const puzzleId of puzzleIds) {
      const matches = [];
      await streamAttempts(puzzleId, (a) => {
        if (a.mnemonic.toLowerCase().includes(lowerQuery) || a.address.toLowerCase().includes(lowerQuery)) matches.push(a);
        return matches.length >= 1000;
      });
      if (matches.length > 0) {
        const info = getPuzzleInfo(puzzleId, ctx);
        results.push({ puzzleId, puzzleName: info?.name || puzzleId, targetAddress: info?.targetAddress || "", matches });
      }
    }
    return { count: results.length, results };
  }

  if (input.action === "list_attempts") {
    if (!input.puzzleId) return { error: "puzzleId ist erforderlich" };
    const offset = Math.max(0, Number(input.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(input.limit) || 100));
    const rows = [];
    let seen = 0;
    // No index into the file - deep offsets stream from the start each call, so paging is
    // "load more" (offset only grows), not free random access. Fine for a viewer, not a DB.
    await streamAttempts(input.puzzleId, (a) => {
      seen++;
      if (seen <= offset) return false;
      rows.push(a);
      return rows.length >= limit;
    });
    const knownTotal = persistedMnemonics.get(input.puzzleId)?.size;
    return { offset, limit, count: rows.length, rows, total: knownTotal ?? null, hasMore: rows.length === limit };
  }

  if (input.action === "check_phrase") {
    if (!input.phrase) return { error: "phrase ist erforderlich" };
    const phrase = input.phrase.trim();
    for (const puzzleId of activePuzzles.keys()) {
      if (getPersistedMnemonics(puzzleId, ctx).has(phrase)) return { exists: true, puzzleId };
    }
    for (const csvFile of readdirSync(attemptsDir).filter((f) => f.endsWith("-attempts.csv"))) {
      const puzzleId = csvFile.replace("-attempts.csv", "");
      if (getPersistedMnemonics(puzzleId, ctx).has(phrase)) return { exists: true, puzzleId };
    }
    return { exists: false };
  }

  return { error: `Unbekannte action: ${input.action}` };
}
