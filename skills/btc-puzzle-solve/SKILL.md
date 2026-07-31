---
name: btc-puzzle-solve
description: Multi-puzzle Bitcoin BIP39 solver with REST API integration and live event streaming.
related_skills: [memory, coding-system, shared-workspace-ops, plan, history-search, workflow-orchestrator]
primary_skills: [memory, coding-system, test-driven-development]
fallback_skills: [memory, plan, history-search]
---

# BTC Puzzle Solve Skill - Multi-Puzzle Solver

Manages Bitcoin Puzzle BIP39 searches via REST API with support for multiple concurrent puzzles, combination tracking, and live event streaming to the Agent display.

## Overview

This skill provides a unified interface to the Bitcoin Puzzle Solver API, enabling:
- **Multi-puzzle management** — Create, pause, resume, and stop multiple puzzles simultaneously
- **Combination tracking** — Prevents duplicate attempts and tracks tried combinations
- **Strategy mixing** — Alternates between random and ordered word combinations
- **Live events** — Emits events for Agent display updates (attempts, progress, success)
- **Performance metrics** — Tracks attempts/second, elapsed time, and puzzle statistics

## API Endpoints

### Create Puzzle
```bash
POST /api/bitcoin-puzzle
Content-Type: application/json

{
  "targetAddress": "1A1z7agoat...",
  "name": "Alpha Puzzle",
  "infoUrl": "https://example.com/puzzle-info",
  "startMnemonic": "abandon ability able about..." (optional)
}

Response: { id, name, targetAddress, infoUrl, createdAt, status, ... }
```

### List All Puzzles (active + saved)
```bash
GET /api/bitcoin-puzzle

Response: { puzzles: [...] }
# Returns active puzzles AND saved puzzles from disk
```

### Get Puzzle Details
```bash
GET /api/bitcoin-puzzle/:puzzleId

Response: {
  id, name, targetAddress, infoUrl, createdAt,
  status, generatedAddresses, elapsedSeconds,
  addressesPerSecond, isRunning, foundAddress,
  foundMnemonic, error, triedCombinationsCount,
  currentCombinationMode, lastUpdate, recentAttempts[]
}
# Includes last 50 attempts for UI display
```

### Control Puzzle
```bash
POST /api/bitcoin-puzzle/:puzzleId/pause  # Saves state to disk
POST /api/bitcoin-puzzle/:puzzleId/resume # Restarts solver with saved state
POST /api/bitcoin-puzzle/:puzzleId/stop   # Stops and removes from active list
```

### Edit Puzzle Metadata
```bash
PATCH /api/bitcoin-puzzle/:puzzleId
Content-Type: application/json

{
  "name": "New Name",
  "infoUrl": "https://new-url.com"
}
```

### Mark Phrase as Tried (Complete or Partial)
```bash
POST /api/bitcoin-puzzle/:puzzleId/mark-phrase
Content-Type: application/json

{
  "phrase": "abandon ability able about above abroad absence absorb abstract abundant access __",
  "address": "1A1z7agoat..." (optional)
}

# Complete phrase: 1 entry added to CSV
# Partial phrase (with __ or ?): Up to 2048 combinations generated
# Returns: { success, generatedCount, isPartial }
```

### Search CSV - Single Puzzle
```bash
POST /api/bitcoin-puzzle/:puzzleId/search
Content-Type: application/json

{ "query": "abandon" }

Response: { puzzleId, query, matchCount, matches[] }
```

### Search CSV - All Puzzles
```bash
POST /api/bitcoin-puzzle/search/all
Content-Type: application/json

{ "query": "abandon" }

Response: {
  query, resultCount, totalMatches,
  results: [{
    puzzleId, puzzleName, targetAddress,
    matches: [{ mnemonic, address }]
  }]
}
# Searches across ALL puzzle CSVs
```

### Download CSV
```bash
GET /api/bitcoin-puzzle/:puzzleId/attempts.csv

# Returns CSV file with all tried phrases and addresses
# Format: mnemonic,address
```

## Workflow

### 1. Create Puzzle
```
Agent Command: Create puzzle for Bitcoin address 1KfZGvwZxsvSmemoCmEV75uqcNzYBHjkHZ
→ POST /api/bitcoin-puzzle { targetAddress, name, infoUrl }
→ Solver starts automatically
→ Returns puzzle ID for tracking
```

### 2. Monitor Progress
```
Poll GET /api/bitcoin-puzzle/:puzzleId every 2-5 seconds
Display:
  - Attempted combinations: generatedAddresses
  - Attempts/sec: addressesPerSecond
  - Tried combinations: triedCombinationsCount
  - Current strategy: currentCombinationMode (random/ordered/exhaustive)
  - Elapsed time: elapsedSeconds
```

### 3. Handle Success
```
When foundAddress and foundMnemonic populated:
→ Emit "found" event to Agent display
→ Show success notification with address and mnemonic
→ Provide copy-to-clipboard functionality
```

### 4. Manage Multiple Puzzles
```
Create multiple puzzles → Each runs independently
Pause one → Others continue
Resume paused → Resumes from where it left off
Stop puzzle → Removes from active list
```

## Strategy Details

### Combination Modes
- **random** (default) — Generates random valid BIP39 mnemonics
- **ordered** (every 5000 attempts) — Systematic ordered word combinations
- **exhaustive** (future) — Complete permutation search (computationally intensive)

### Duplicate Prevention
- All attempted combinations tracked in `Set<string>`
- Before attempting: check if mnemonic already tried
- Skip duplicates to optimize search
- Combination count displayed in UI and events

## Integration with Agent Display

Events emitted to Agent live display:

### Event Types
```
attempt: { attemptNumber, mode, triedCombinationsCount }
  Emitted every 500 attempts
  Shows current progress and strategy

progress: { generatedCount, triedCombinationsCount, elapsedMs }
  Emitted every 1000 attempts
  Updates performance metrics

found: { address, mnemonic, attempts, elapsedMs }
  Emitted when puzzle solved
  Triggers success notification

error: { error }
  Emitted on solver errors
  Displays in UI error section

started: { targetAddress }
  Emitted when puzzle begins
  Shows in event log

stopped: { reason, attempts }
  Emitted when puzzle stops
  Logs final statistics
```

## UI Display Format

### Details Panel
```
Puzzle: Alpha Puzzle
Target: 1KfZGvwZxsvSmemoCmEV75uqcNzYBHjkHZ
Info: [Link to https://...]

Statistics:
  Attempted Combinations: 1,234,567
  Combinations/Second: 2,345
  Tried Combinations: 987,654 (duplicates prevented)
  Current Strategy: ordered
  Elapsed Time: 8m 32s
  Status: running

Controls:
  [Play/Pause] [Stop]

Success (if found):
  ✓ Bitcoin Address: 1A1z7agoat...
  ✓ Mnemonic: abandon ability able about...
  [Copy] buttons for each
```

## Agent Integration

When Agent receives task to solve puzzle:

```typescript
// Agent calls via MCP
await mcp.call("bitcoin-puzzle-solve", {
  targetAddress: "1KfZGvwZxsvSmemoCmEV75uqcNzYBHjkHZ",
  name: "Alpha Puzzle",
  infoUrl: "https://example.com/puzzle-info"
});

// Tool creates puzzle via API
// Emits events continuously
// Agent receives: started → progress → progress → ... → found
// Agent displays live updates in output
```

## Error Handling

- **Invalid address** → Returns error with validation message
- **Invalid starting mnemonic** → Validates and returns error
- **Solver error** → Emits error event, stops puzzle
- **Rate limiting** → None (local solver, no external API)
- **Memory issues** → Monitor combination Set size, may need cleanup strategy

## Performance Tips

1. **Multiple puzzles** — Run 2-3 simultaneously for different targets
2. **Monitor rate** — Poll API every 2-5 seconds (not too frequent)
3. **Combination tracking** — Memory grows with attempts (set size)
4. **Strategy mix** — Random + ordered mix improves coverage

## Advanced Features

### Pause/Resume with State Persistence
- Puzzles automatically save state to disk when paused
- Resume restarts solver with exact state (generatedCount, triedCombinations, recentAttempts)
- CSV grows continuously with new attempts
- Solver intelligently avoids re-testing phrases

### CSV Persistence & Search
- All attempts written to CSV on disk (appended, never overwritten)
- CSV Search API checks both active and saved puzzles
- Prevents duplicate phrases across multiple puzzle runs
- Supports searching across ALL puzzles simultaneously

### Partial Phrase Completion
- Input: "word1 word2 __ word4 __ word6" (up to 2 missing positions)
- Generates all 2048^N combinations where N = missing count
- Max ~1M combinations to keep performance reasonable
- Useful for brute-forcing forgotten words

### Files & Storage

- **Wordlist:** `apps/server/shared-workspace/btc-puzzle/english.txt` (2048 BIP39 words)
- **State Persistence:** `/apps/server/shared-workspace/bitcoin-puzzle-attempts/`
  - `{puzzleId}-state.json` — Puzzle metadata and current state
  - `{puzzleId}-attempts.csv` — All attempted phrases and addresses
- **API Base:** `http://localhost:3001/api/bitcoin-puzzle` (port 3001)

## ⚠️ Important Notes

1. **Persistence enabled** — Puzzles save state to disk, survive server restarts ✅
2. **No external APIs** — All solving is local, no blockchain queries for generation
3. **Memory efficient** — Only keeps last 50 attempts in memory, uses CSV for full history
4. **Parallel safe** — Multiple puzzles run independently without conflicts
5. **CSV Search** — Searches all puzzles simultaneously, prevents cross-puzzle duplicates
6. **Phrase Marking** — Can manually add complete OR partial phrases to be tried
