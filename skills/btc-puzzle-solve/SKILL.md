---
name: btc-puzzle-solve
description: Führt Bitcoin-Puzzle BIP39-Suche aus und meldet via Discord
related_skills: [memory, coding-system, shared-workspace-ops, plan, history-search, workflow-orchestrator]
primary_skills: [memory, coding-system, test-driven-development]
fallback_skills: [memory, plan, history-search]
---
# skill has no own tool - use only tools in this descriptions

# BTC Puzzle Solve 0.2-btc-puzzle
Url: https://privatekeys.pw/puzzles/0.2-btc-puzzle
Dieses Skill führt die BIP39-2-Wort-Suche für das 0.2 BTC BLM-Puzzle aus.

# Maybe known Base Key Phrase: 
moon tower food this real subject address total ten black

# Target BTC Address
1KfZGvwZxsvSmemoCmEV75uqcNzYBHjkHZ

# achtung
Schalte niemals den nodejs aus. nutze auf keinen fall killtask node.exe.

# 🔧 Aktionen ausgeführt:
insights.json reinitialisiert
node btc-puzzle/init.js --update-insights

Batch-Processing reduziert
node btc-puzzle/batch.js --size 1000

1.000 Combos/Batch zur Stabilität.

Worker-Recovery aktiviert
node btc-puzzle/repair_workers.js --threads 2-3

# Files & ordner nutzen
Directory: apps/server/shared-workspace/btc-puzzle/ | grep -E 'solver|worker'
solver_state.json  
solver-optimized.js  
solve.js  
worker-healthcheck.log*

# Wortliste = english.txt (2048 BIP39-Wörter)  

# Create only on Task, and use it again
Task #2 (BTC BLM 0.2 Puzzle)

🔔 Notifizierung geplant in 30 Minunts:
Aktiviert Worker-Failover: Umswitch zu solver-parallel.js (Basic Thread-Modul) falls Coverage < 0.5% bleibt.

# Security-first Implementation:
Dry-run write: Validate file creation without actual modification.
Use allowed paths: Write directly to apps/server/shared-workspace/btc-puzzle/.
Message sanitization: Ensure any worker communication avoids XSS risks.

# Use Memory & LM-Wiki to Remembering & Learning 
korrekter Funktionsreihenfolge (loadState vor main)
derive.js erstellen (falls noch nicht vorhanden)