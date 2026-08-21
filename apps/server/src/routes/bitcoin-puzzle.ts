import { Router, type IRouter } from "express";
import { createApiError, createApiResponse } from "@ducki/shared";
import { BitcoinPuzzleService } from "@ducki/agent";
import { createReadStream, existsSync, statSync } from "node:fs";

export const bitcoinPuzzleRouter: IRouter = Router();

const service = BitcoinPuzzleService.getInstance();

// Lade gespeicherte Puzzle States beim Start
(async () => {
  await service.initializeFromDatabase().catch((err) => {
    console.error("[BitcoinPuzzleRouter] Failed to initialize from saved states:", err);
  });
})();

/**
 * GET /api/bitcoin-puzzle
 * Liste ALLE Puzzles auf (aktive + gespeicherte)
 */
bitcoinPuzzleRouter.get("/", (_req, res) => {
  try {
    const puzzles = service.getAllPuzzlesInfo();
    res.json(
      createApiResponse({
        puzzles: puzzles.map((p) => ({
          id: p.id,
          name: p.name,
          targetAddress: p.targetAddress,
          status: p.status,
          generatedAddresses: p.generatedCount,
          triedCombinationsCount: p.triedCombinationsCount,
          found: p.found,
        })),
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * POST /api/bitcoin-puzzle
 * Starte neuen Bitcoin Puzzle Solver-Prozess
 */
bitcoinPuzzleRouter.post("/", async (req, res) => {
  try {
    const { targetAddress, startMnemonic, name, infoUrl } = req.body;

    if (!targetAddress) {
      res.status(400).json(createApiError("targetAddress is required"));
      return;
    }

    // Validiere Bitcoin-Adresse
    if (!isValidBitcoinAddress(targetAddress)) {
      res.status(400).json(createApiError("Invalid Bitcoin address format"));
      return;
    }

    const result = await service.startPuzzle({
      targetAddress,
      startMnemonic,
      name,
      infoUrl,
    });

    res.json(
      createApiResponse({
        success: true,
        id: result.id,
        status: result.state.status,
        target: targetAddress,
        startedAt: new Date(result.state.startedAt).toISOString(),
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * GET /api/bitcoin-puzzle/:puzzleId
 * Hole Puzzle-Details
 */
bitcoinPuzzleRouter.get("/:puzzleId", (req, res) => {
  try {
    const puzzleId = req.params.puzzleId;
    const puzzle = service.getPuzzle(puzzleId);

    if (!puzzle) {
      res.status(404).json(createApiError("Puzzle not found"));
      return;
    }

    const info = service.getPuzzleInfo(puzzleId);

    res.json(
      createApiResponse({
        id: puzzle.metadata.id,
        name: puzzle.metadata.name,
        targetAddress: puzzle.metadata.targetAddress,
        infoUrl: puzzle.metadata.infoUrl,
        createdAt: new Date(puzzle.metadata.createdAt).toISOString(),
        status: puzzle.state.status,
        generatedAddresses: puzzle.state.generatedCount,
        triedCombinationsCount: info?.triedCombinationsCount || 0,
        currentCombinationMode: info?.currentCombinationMode || "random",
        elapsedSeconds: info?.elapsedSeconds || 0,
        addressesPerSecond: info?.addressesPerSecond || 0,
        isRunning: info?.isRunning || false,
        foundAddress: puzzle.state.foundAddress || null,
        foundMnemonic: puzzle.state.foundMnemonic || null,
        error: puzzle.state.errorMessage || null,
        lastUpdate: new Date(puzzle.state.lastCheckAt).toISOString(),
        recentAttempts: info?.recentAttempts || [],
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * POST /api/bitcoin-puzzle/:puzzleId/pause
 * Pausiere Puzzle
 */
bitcoinPuzzleRouter.post("/:puzzleId/pause", (_req, res) => {
  try {
    const state = service.pausePuzzle(_req.params.puzzleId);

    if (!state) {
      res.status(404).json(createApiError("Puzzle not found"));
      return;
    }

    res.json(
      createApiResponse({
        success: true,
        status: state.status,
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * POST /api/bitcoin-puzzle/:puzzleId/resume
 * Fortsetzen
 */
bitcoinPuzzleRouter.post("/:puzzleId/resume", (req, res) => {
  try {
    const state = service.resumePuzzle(req.params.puzzleId);

    if (!state) {
      res.status(404).json(createApiError("Puzzle not found"));
      return;
    }

    res.json(
      createApiResponse({
        success: true,
        status: state.status,
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * POST /api/bitcoin-puzzle/:puzzleId/stop
 * Stoppe Puzzle
 */
bitcoinPuzzleRouter.post("/:puzzleId/stop", (req, res) => {
  try {
    const state = service.stopPuzzle(req.params.puzzleId);

    if (!state) {
      res.status(404).json(createApiError("Puzzle not found"));
      return;
    }

    res.json(
      createApiResponse({
        success: true,
        status: state.status,
        generatedAddresses: state.generatedCount,
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * PATCH /api/bitcoin-puzzle/:puzzleId
 * Bearbeite Puzzle-Metadaten (Name, infoUrl)
 */
bitcoinPuzzleRouter.patch("/:puzzleId", (req, res) => {
  try {
    const { name, infoUrl } = req.body;

    const metadata = service.updatePuzzleMetadata(req.params.puzzleId, {
      name,
      infoUrl,
    });

    if (!metadata) {
      res.status(404).json(createApiError("Puzzle not found"));
      return;
    }

    res.json(
      createApiResponse({
        success: true,
        metadata,
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * DELETE /api/bitcoin-puzzle/:puzzleId
 * Lösche ein Puzzle und alle zugehörigen Dateien
 */
bitcoinPuzzleRouter.delete("/:puzzleId", (req, res) => {
  try {
    const success = service.deletePuzzle(req.params.puzzleId);

    if (!success) {
      res.status(404).json(createApiError("Puzzle not found"));
      return;
    }

    res.json(
      createApiResponse({
        success: true,
        message: "Puzzle deleted successfully",
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * POST /api/bitcoin-puzzle/:puzzleId/mark-phrase
 * Markiere eine Phrase manuell als bereits versucht
 * Nutzer kann eine Phrase eingeben die beachtet werden soll
 */
bitcoinPuzzleRouter.post("/:puzzleId/mark-phrase", (req, res) => {
  try {
    const { phrase, address } = req.body;

    if (!phrase || typeof phrase !== "string") {
      res.status(400).json(createApiError("phrase parameter required"));
      return;
    }

    const result = service.markPhraseAsTried(req.params.puzzleId, phrase, address || "");

    if (!result.success) {
      res.status(400).json(createApiError(result.error || "Failed to mark phrase"));
      return;
    }

    const isPartial = phrase.includes("__") || phrase.includes("?");
    res.json(
      createApiResponse({
        success: true,
        message: isPartial
          ? `Generated and added ${result.generatedCount} phrase combinations for puzzle ${req.params.puzzleId}`
          : `Phrase marked as tried for puzzle ${req.params.puzzleId}`,
        generatedCount: result.generatedCount,
        isPartial,
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * POST /api/bitcoin-puzzle/search/all
 * Suche nach Phrase oder Adresse in ALLEN Puzzles
 * MUSS vor /:puzzleId/search definiert sein damit Express es nicht als puzzleId="search" interpretiert!
 */
bitcoinPuzzleRouter.post("/search/all", async (req, res) => {
  try {
    const { query } = req.body;

    if (!query || typeof query !== "string") {
      res.status(400).json(createApiError("query parameter required"));
      return;
    }

    const results = await service.searchAllPuzzleAttempts(query);

    res.json(
      createApiResponse({
        query,
        resultCount: results.length,
        totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0),
        results,
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * POST /api/bitcoin-puzzle/:puzzleId/search
 * Suche nach Phrase oder Adresse im einzelnen Puzzle
 */
bitcoinPuzzleRouter.post("/:puzzleId/search", async (req, res) => {
  try {
    const { query } = req.body;

    if (!query || typeof query !== "string") {
      res.status(400).json(createApiError("query parameter required"));
      return;
    }

    const matches = await service.searchPuzzleAttempts(req.params.puzzleId, query);

    res.json(
      createApiResponse({
        puzzleId: req.params.puzzleId,
        query,
        matchCount: matches.length,
        matches,
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * POST /api/bitcoin-puzzle/check-phrase
 * Prüfe ob eine Phrase in irgendeinem Puzzle existiert
 */
bitcoinPuzzleRouter.post("/check-phrase", (req, res) => {
  try {
    const { phrase } = req.body;

    if (!phrase || typeof phrase !== "string") {
      res.status(400).json(createApiError("phrase parameter required"));
      return;
    }

    const result = service.phraseExistsAnyPuzzle(phrase);

    res.json(
      createApiResponse({
        phrase,
        exists: result.exists,
        puzzleId: result.puzzleId || null,
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * POST /api/bitcoin-puzzle/:puzzleId/found
 * Markiere Puzzle als gefunden und importiere in Wallet
 */
bitcoinPuzzleRouter.post("/:puzzleId/found", (req, res) => {
  try {
    const { mnemonic } = req.body;

    if (!mnemonic) {
      res.status(400).json(createApiError("mnemonic is required"));
      return;
    }

    const puzzleId = req.params.puzzleId;
    const puzzle = service.getPuzzle(puzzleId);

    if (!puzzle) {
      res.status(404).json(createApiError("Puzzle not found"));
      return;
    }

    // Markiere als gefunden (State wird direkt gespeichert via onProgressCallback)
    // Das Puzzle sollte seinen Status selbst updaten wenn mnemonic gefunden wird
    console.log(`[BitcoinPuzzleRouter] Puzzle ${puzzleId} found with mnemonic: ${mnemonic.substring(0, 20)}...`);

    // Importiere in Wallet
    service.importFoundMnemonicToWallet(mnemonic, `Bitcoin Puzzle ${puzzleId}`).catch((err) => {
      console.error(`[BitcoinPuzzleRouter] Error importing mnemonic: ${err}`);
    });

    res.json(
      createApiResponse({
        success: true,
        puzzleId,
        status: "found",
        message: "Puzzle marked as found and mnemonic queued for wallet import",
      })
    );
  } catch (error) {
    res.status(400).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * GET /api/bitcoin-puzzle/:puzzleId/attempts.csv
 * Lade CSV mit allen versuchten Phrases und Adressen
 */
bitcoinPuzzleRouter.get("/:puzzleId/attempts.csv", (req, res) => {
  try {
    const csvPath = service.getAttemptsFilePath(req.params.puzzleId);

    // Prüfe ob Datei existiert
    if (!existsSync(csvPath)) {
      res.status(404).json(createApiError("Attempts file not found"));
      return;
    }

    const size = statSync(csvPath).size;

    // Stream die CSV statt sie komplett zu lesen: die Attempts-Datei kann hunderte MB
    // groß sein - readFileSync würde dort an ERR_STRING_TOO_LONG (>512 MB) scheitern.
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.puzzleId}-attempts.csv"`);

    // Range-Support: Clients (Vorschau, Download-Wiederaufnahme) können nur einen Teil
    // anfordern. Ohne diese Behandlung würde ein `bytes=0-99`-Request den GESAMTEN
    // 815-MB-Stream servieren - mit createReadStream({ start, end }) liest der Server nur
    // das angeforderte Fenster und belastet sich nicht mit der restlichen Datei.
    const rangeHeader = typeof req.headers["range"] === "string" ? req.headers["range"] : undefined;
    const rangeMatch = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
    if (rangeMatch && (rangeMatch[1] || rangeMatch[2])) {
      let start: number;
      let end: number;
      if (rangeMatch[1] === "") {
        // Suffix-Range: bytes=-N  ->  die letzten N Bytes
        const suffix = Number.parseInt(rangeMatch[2] ?? "0", 10);
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = Number.parseInt(rangeMatch[1] ?? "0", 10);
        end = !rangeMatch[2] ? size - 1 : Math.min(Number.parseInt(rangeMatch[2], 10), size - 1);
      }
      if (start >= size || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${size}`).json(createApiError("Range not satisfiable"));
        return;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", end - start + 1);
      const rangeStream = createReadStream(csvPath, { start, end });
      rangeStream.on("error", (error) => {
        console.error(`Error streaming CSV range: ${error}`);
        if (!res.headersSent) {
          res.status(500).json(createApiError(error instanceof Error ? error.message : String(error)));
        } else {
          res.end();
        }
      });
      rangeStream.pipe(res);
      return;
    }

    res.setHeader("Content-Length", size);
    const stream = createReadStream(csvPath);
    stream.on("error", (error) => {
      console.error(`Error streaming CSV: ${error}`);
      if (!res.headersSent) {
        res.status(500).json(createApiError(error instanceof Error ? error.message : String(error)));
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  } catch (error) {
    console.error(`Error serving CSV: ${error}`);
    res.status(500).json(createApiError(error instanceof Error ? error.message : String(error)));
  }
});

/**
 * Validiere Bitcoin-Adresse
 * Unterstützt P2PKH (1...), P2SH (3...), P2WPKH (bc1...)
 */
function isValidBitcoinAddress(address: string): boolean {
  // P2PKH: Startet mit 1
  if (/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;

  // P2SH: Startet mit 3
  if (/^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;

  // P2WPKH (Segwit): Startet mit bc1
  if (/^bc1[a-z0-9]{39,59}$/.test(address)) return true;

  return false;
}
