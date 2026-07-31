import { BitcoinPuzzleService } from "../crypto/bitcoin-puzzle-service";

/**
 * DEPRECATED: Verwende stattdessen die REST API `/api/bitcoin-puzzle`
 *
 * Die REST API unterstützt Multi-Puzzle Management:
 * - POST /api/bitcoin-puzzle - Create new puzzle
 * - GET /api/bitcoin-puzzle - List all puzzles
 * - GET /api/bitcoin-puzzle/:puzzleId - Get puzzle details
 * - POST /api/bitcoin-puzzle/:puzzleId/pause - Pause puzzle
 * - POST /api/bitcoin-puzzle/:puzzleId/resume - Resume puzzle
 * - POST /api/bitcoin-puzzle/:puzzleId/stop - Stop puzzle
 */
export const createBitcoinPuzzleTools = () => {
  return {
    name: "bitcoin-puzzle",
    description: "Bitcoin Puzzle Solver - USE REST API INSTEAD (/api/bitcoin-puzzle)",
    actions: {
      info: async () => ({
        success: false,
        message: "This tool is deprecated. Use REST API: POST /api/bitcoin-puzzle to create puzzles",
        apiUrl: "http://localhost:3000/api/bitcoin-puzzle",
      }),
    },
  };
};

export { BitcoinPuzzleService };
