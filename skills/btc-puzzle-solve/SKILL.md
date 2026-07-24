---
name: btc-puzzle-solve
description: Performs Bitcoin Puzzle BIP39 searches and reports progress via Discord.
related_skills: [memory, coding-system, shared-workspace-ops, plan, history-search, workflow-orchestrator]
primary_skills: [memory, coding-system, test-driven-development]
fallback_skills: [memory, plan, history-search]
---

# BTC Puzzle Solve Skill (0.2 BTC Puzzle)

This skill manages the BIP39-2 word search for the 0.2 BTC BLM Puzzle.

## Project Context
- **Target Puzzle URL:** https://privatekeys.pw/puzzles/0.2-btc-puzzle
- **Target BTC Address:** `1KfZGvwZxsvSmemoCmEV75uqcNzYBHjkHZ`
- **Known Base Key Phrase (Potential):** `moon tower food this real subject address total ten black`
- **Wordlist:** `english.txt` (2048 BIP39 words)
- **Project Name:** BTC BLM 0.2 Puzzle (Task #2)

## ⚠️ CRITICAL OPERATIONAL RULES
1. **DO NOT terminate the Node.js process.** Never use `killtask node.exe`. The solver must remain running.
2. **File Path Constraints:** Write all files only within the project directory in `shared-workspace`.
3. **Environment Check:** Verify if `CODING_ENABLED=true` is set and check for existing tasks/cronjobs for "BTC BLM 0.2 Puzzle" before starting.
4. **Scripting:** Create solving scripts in pure JavaScript using CDN libraries only.

## Workflow & Actions

### 1. Initialization
- Reinitialize `insights.json` if necessary.
- Run update: `node btc-puzzle/init.js --update-insights`

### 2. Solving & Processing
- **Batch Stability:** Use a reduced batch size of 1000 for stability.
- **Batch Execution:** `node btc-puzzle/batch.js --size 1000`
- **Worker Recovery:** If workers fail, activate recovery: `node btc-puzzle/repair_workers.js --threads 2-3`

### 3. Failover Mechanism
- **Worker Failover:** If coverage remains below 0.5%, switch to `solver-parallel.js` (Basic Thread Module).
- **Notification:** Planned notification every 30 minutes.

## Files & Directory Structure
- **Base Directory:** `apps/server/shared-workspace/btc-puzzle/`
- **Key Files:**
  - `solver_state.json`
  - `solver-optimized.js`
  - `solve.js`
  - `worker-healthcheck.log*`

## Security & Reliability
- **Dry-Run Validation:** Always validate file creation without actual modification first.
- **Path Integrity:** Write directly to `apps/server/shared-workspace/btc-puzzle/`.
- **Sanitization:** Ensure worker communications are sanitized to avoid XSS risks.

## Memory & Learning
- **Execution Order:** Always load state before running the main logic (`loadState` before `main`).
- **Dependency Check:** Ensure `derive.js` exists; create it if it is missing.
