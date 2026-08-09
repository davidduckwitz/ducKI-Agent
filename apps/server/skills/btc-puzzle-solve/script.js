/**
 * BTC Puzzle Solve Skill
 * Manages Bitcoin BIP39 puzzle solving via REST API
 * Supports: creation, pause/resume, CSV search, phrase marking, partial phrases
 */

const API_BASE = "http://localhost:3001/api/bitcoin-puzzle";

// Main skill handler
async function handleSkillCall(action, params) {
  console.log(`[BTC Puzzle] Action: ${action}`, params);

  switch (action) {
    case "create":
      return await createPuzzle(params);

    case "list":
      return await listPuzzles();

    case "details":
      return await getPuzzleDetails(params.puzzleId);

    case "pause":
      return await pausePuzzle(params.puzzleId);

    case "resume":
      return await resumePuzzle(params.puzzleId);

    case "stop":
      return await stopPuzzle(params.puzzleId);

    case "mark-phrase":
      return await markPhrase(params.puzzleId, params.phrase, params.address);

    case "search-puzzle":
      return await searchPuzzle(params.puzzleId, params.query);

    case "search-all":
      return await searchAll(params.query);

    case "download-csv":
      return await downloadCSV(params.puzzleId);

    case "edit":
      return await editPuzzle(params.puzzleId, params.name, params.infoUrl);

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// Create new puzzle
async function createPuzzle({ targetAddress, name, infoUrl, startMnemonic }) {
  const response = await fetch(`${API_BASE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetAddress,
      name: name || "Bitcoin Puzzle",
      infoUrl: infoUrl || "",
      startMnemonic: startMnemonic || undefined,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create puzzle: ${response.statusText}`);
  }

  const result = await response.json();
  return {
    success: true,
    puzzleId: result.data.id,
    targetAddress: result.data.target,
    status: result.data.status,
    startedAt: result.data.startedAt,
  };
}

// List all puzzles
async function listPuzzles() {
  const response = await fetch(`${API_BASE}`);

  if (!response.ok) {
    throw new Error(`Failed to list puzzles: ${response.statusText}`);
  }

  const result = await response.json();
  return {
    success: true,
    count: result.data.puzzles.length,
    puzzles: result.data.puzzles.map((p) => ({
      id: p.id,
      name: p.name,
      targetAddress: p.targetAddress,
      status: p.status,
      generatedAddresses: p.generatedAddresses,
      triedCombinationsCount: p.triedCombinationsCount,
      found: p.found,
    })),
  };
}

// Get puzzle details with recent attempts
async function getPuzzleDetails(puzzleId) {
  const response = await fetch(`${API_BASE}/${puzzleId}`);

  if (!response.ok) {
    throw new Error(`Failed to get puzzle details: ${response.statusText}`);
  }

  const result = await response.json();
  const data = result.data;

  return {
    success: true,
    id: data.id,
    name: data.name,
    targetAddress: data.targetAddress,
    infoUrl: data.infoUrl,
    status: data.status,
    generatedAddresses: data.generatedAddresses,
    triedCombinationsCount: data.triedCombinationsCount,
    currentCombinationMode: data.currentCombinationMode,
    elapsedSeconds: data.elapsedSeconds,
    addressesPerSecond: data.addressesPerSecond,
    isRunning: data.isRunning,
    foundAddress: data.foundAddress,
    foundMnemonic: data.foundMnemonic,
    error: data.error,
    recentAttemptsCount: data.recentAttempts?.length || 0,
    recentAttempts: (data.recentAttempts || []).slice(-10), // Last 10 for display
  };
}

// Pause puzzle (saves state to disk)
async function pausePuzzle(puzzleId) {
  const response = await fetch(`${API_BASE}/${puzzleId}/pause`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Failed to pause puzzle: ${response.statusText}`);
  }

  const result = await response.json();
  return {
    success: true,
    puzzleId,
    status: result.data.status,
    message: "Puzzle paused and state saved",
  };
}

// Resume puzzle (restarts with saved state)
async function resumePuzzle(puzzleId) {
  const response = await fetch(`${API_BASE}/${puzzleId}/resume`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Failed to resume puzzle: ${response.statusText}`);
  }

  const result = await response.json();
  return {
    success: true,
    puzzleId,
    status: result.data.status,
    message: "Puzzle resumed from saved state",
  };
}

// Stop puzzle (removes from active list)
async function stopPuzzle(puzzleId) {
  const response = await fetch(`${API_BASE}/${puzzleId}/stop`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Failed to stop puzzle: ${response.statusText}`);
  }

  const result = await response.json();
  return {
    success: true,
    puzzleId,
    status: result.data.status,
    generatedAddresses: result.data.generatedAddresses,
    message: "Puzzle stopped",
  };
}

// Mark phrase as tried (complete or partial with __)
async function markPhrase(puzzleId, phrase, address = "") {
  const response = await fetch(`${API_BASE}/${puzzleId}/mark-phrase`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phrase, address }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to mark phrase: ${error.error}`);
  }

  const result = await response.json();
  return {
    success: true,
    puzzleId,
    message: result.data.message,
    generatedCount: result.data.generatedCount,
    isPartial: result.data.isPartial,
  };
}

// Search single puzzle CSV
async function searchPuzzle(puzzleId, query) {
  const response = await fetch(`${API_BASE}/${puzzleId}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`Failed to search puzzle: ${response.statusText}`);
  }

  const result = await response.json();
  return {
    success: true,
    puzzleId,
    query,
    matchCount: result.data.matchCount,
    matches: result.data.matches || [],
  };
}

// Search ALL puzzles CSVs
async function searchAll(query) {
  const response = await fetch(`${API_BASE}/search/all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`Failed to search all puzzles: ${response.statusText}`);
  }

  const result = await response.json();
  return {
    success: true,
    query,
    totalResults: result.data.resultCount,
    totalMatches: result.data.totalMatches,
    results: (result.data.results || []).map((r) => ({
      puzzleId: r.puzzleId,
      puzzleName: r.puzzleName,
      targetAddress: r.targetAddress,
      matchCount: r.matches.length,
      matches: r.matches,
    })),
  };
}

// Download puzzle CSV
async function downloadCSV(puzzleId) {
  const response = await fetch(`${API_BASE}/${puzzleId}/attempts.csv`);

  if (!response.ok) {
    throw new Error(`Failed to download CSV: ${response.statusText}`);
  }

  const csvContent = await response.text();
  const lines = csvContent.split("\n").filter((l) => l.trim());

  return {
    success: true,
    puzzleId,
    totalLines: lines.length,
    headerPresent: lines[0]?.includes("mnemonic"),
    dataLines: lines.length - 1,
    csvUrl: `${API_BASE}/${puzzleId}/attempts.csv`,
  };
}

// Edit puzzle metadata
async function editPuzzle(puzzleId, name, infoUrl) {
  const response = await fetch(`${API_BASE}/${puzzleId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: name || undefined,
      infoUrl: infoUrl || undefined,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to edit puzzle: ${response.statusText}`);
  }

  const result = await response.json();
  return {
    success: true,
    puzzleId,
    metadata: result.data.metadata,
    message: "Puzzle updated",
  };
}

// Export for MCP/Skill framework
module.exports = {
  handleSkillCall,
  createPuzzle,
  listPuzzles,
  getPuzzleDetails,
  pausePuzzle,
  resumePuzzle,
  stopPuzzle,
  markPhrase,
  searchPuzzle,
  searchAll,
  downloadCSV,
  editPuzzle,
};
