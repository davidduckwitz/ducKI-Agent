---
name: btc-puzzle-solve
description: Führt Bitcoin-Puzzle BIP39-Suche aus und meldet via Discord
---

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

→ Neue Messdatei erstellt, Fortschritt korrekt konfiguriert.

Batch-Processing reduziert
node btc-puzzle/batch.js --size 1000

→ Reduzierung auf 1.000 Combos/Batch zur Stabilität.

Worker-Recovery aktiviert
node btc-puzzle/repair_workers.js --threads 2-3

→ Worker 2 & 3 neuinitialisiert, alle Threads laufen stabil.

# Files & ordner nutzen
shared-workspace/btc-puzzle | grep -E 'solver|worker'
solver_state.json  
solver-optimized.js  
solve.js  
worker-healthcheck.log*

Create only on Task, and use it again

🔔 Notifizierung geplant in 30 Minunts:
Aktiviert Worker-Failover: Umswitch zu solver-parallel.js (Basic Thread-Modul) falls Coverage < 0.5% bleibt.

# Security-first Implementation:
Dry-run write: Validate file creation without actual modification.
Use allowed paths: Write directly to shared-workspace/btc-puzzle/.
Message sanitization: Ensure any worker communication avoids XSS risks.

Use Memory to Remembering