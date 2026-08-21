import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

/**
 * Baut einen frischen BitcoinPuzzleService (neues Modul -> neue Singleton-Instanz) auf
 * einem Wegwerf-Workspace mit einem State-File und einer Attempts-CSV mit `rows` Zeilen.
 */
async function freshService(rows: number): Promise<{ svc: any; puzzleId: string }> {
  const ws = mkdtempSync(join(tmpdir(), "ducki-puzzle-"));
  dirs.push(ws);
  const attemptsDir = join(ws, "bitcoin-puzzle-attempts");
  mkdirSync(attemptsDir, { recursive: true });

  const puzzleId = "puzzle-loadtest";
  writeFileSync(
    join(attemptsDir, `${puzzleId}-state.json`),
    JSON.stringify(
      {
        id: puzzleId,
        name: "Load Test",
        targetAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        infoUrl: null,
        status: "paused",
        generatedCount: rows,
        // Bewusst stale niedrig: alte State-Files speicherten nur das 50er-Fenster. Der
        // Hintergrund-Index muss den Zähler aus der CSV nach oben korrigieren.
        triedCombinationsCount: 5,
        currentCombinationMode: "random",
        foundAddress: null,
        foundMnemonic: null,
        errorMessage: null,
        startedAt: new Date().toISOString(),
        lastCheckAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );

  const lines = ["mnemonic,address"];
  for (let i = 0; i < rows; i++) {
    lines.push(`"alpha beta gamma delta epsilon zeta eta theta iota kappa ${i}","addr-${i}"`);
  }
  writeFileSync(join(attemptsDir, `${puzzleId}-attempts.csv`), lines.join("\n"), "utf8");

  vi.resetModules();
  process.env["SHARED_WORKSPACE_PATH"] = ws;
  const mod = await import("../src/crypto/bitcoin-puzzle-service.js");
  const svc = mod.BitcoinPuzzleService.getInstance();
  return { svc, puzzleId };
}

async function waitFor(fn: () => boolean, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

describe("BitcoinPuzzleService load decoupling", () => {
  it("startup restores from state JSON without touching the attempts CSV, and the background index catches up", async () => {
    const rows = 200_000; // ~15 MB CSV - gross genug, um Full-Reads weh zu tun
    const { svc, puzzleId } = await freshService(rows);

    const start = Date.now();
    await svc.initializeFromDatabase();
    // Der Start darf NICHT die CSV synchron lesen - er muss schnell sein, sonst wäre der
    // Agent-Start blockiert. (Ein Full-Read von 200k Zeilen dauert > 100 ms.)
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(500);

    const info = svc.getAllPuzzlesInfo();
    expect(info).toHaveLength(1);
    expect(info[0]!.id).toBe(puzzleId);

    // Das Anzeige-Fenster (letzte 50) kommt aus dem Tail-Read, nicht aus einem Full-Read.
    const detail = svc.getPuzzleInfo(puzzleId);
    expect(detail?.recentAttempts.length).toBeGreaterThan(0);
    expect(detail?.recentAttempts.length).toBeLessThanOrEqual(50);
    expect(detail?.recentAttempts.at(-1)?.mnemonic).toContain(`${rows - 1}`);

    // Der Mnemonic-Index wird im Hintergrund gestreamt und holt auf.
    const found = await waitFor(() => svc.phraseExistsInPuzzle(puzzleId, `alpha beta gamma delta epsilon zeta eta theta iota kappa ${rows - 1}`));
    expect(found).toBe(true);
    expect(svc.phraseExistsInPuzzle(puzzleId, "never-generated-phrase")).toBe(false);

    // Der stale State-Zähler (5) wird aus dem CSV-Index auf die echte Zeilenzahl korrigiert.
    const corrected = await waitFor(() => (svc.getPuzzleInfo(puzzleId)?.triedCombinationsCount ?? 0) >= rows);
    expect(corrected).toBe(true);
    expect(svc.getPuzzleInfo(puzzleId)?.triedCombinationsCount).toBe(rows);
  });

  it("startup is instant even with a huge CSV (the file is never read synchronously)", async () => {
    // Simuliert die 815-MB-Situation so nah wie für CI praktikabel: 400k Zeilen (~30 MB).
    // Der eigentliche Schutz (kein readFileSync, kein String-Limit) ist derselbe Code-Pfad
    // wie bei 815 MB - hier wird nur die Laufzeit klein gehalten.
    const rows = 400_000;
    const { svc } = await freshService(rows);
    const start = Date.now();
    await svc.initializeFromDatabase();
    expect(Date.now() - start).toBeLessThan(500);
    expect(svc.getAllPuzzlesInfo()).toHaveLength(1);
  });

  it("searchPuzzleAttempts streams and caps results", async () => {
    // Alle 200k Zeilen matchen -> ohne Cap wären es 200k Treffer.
    const { svc, puzzleId } = await freshService(200_000);
    await svc.initializeFromDatabase();
    const matches = await svc.searchPuzzleAttempts(puzzleId, "alpha beta");
    expect(matches.length).toBe(1000); // Cap
    expect(matches[0]!.mnemonic).toContain("alpha beta");
  });
});
