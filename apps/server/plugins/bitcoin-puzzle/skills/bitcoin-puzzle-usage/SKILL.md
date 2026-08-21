---
name: bitcoin-puzzle-usage
description: How to create, monitor, and control Bitcoin puzzle brute-force solvers with the bitcoin_puzzle tool. Use when the user asks about a "bitcoin puzzle", wants to search for the mnemonic behind a target address, or wants to check/pause/resume/mark progress on one.
---

# Bitcoin puzzle solver

The `bitcoin_puzzle` tool brute-forces random 12-word BIP39 mnemonics, derives a P2PKH Bitcoin address (BIP44 `m/44'/0'/0'/0/0`), and compares it against a target address. State and every tried mnemonic/address pair are stored in flat files (JSON state + append-only CSV per puzzle) — NOT this plugin's own database — so puzzle progress survives restarts and can grow to hundreds of MB without bloating anything else.

Create (or resume, if it already exists — the id is deterministic from the address) and list:
```
[TOOL:bitcoin_puzzle({"action": "create", "targetAddress": "1cryptoGeCRiTzVgxBQcKFFjSVydN1GW7", "name": "0.005 BTC Level 5"})]
[TOOL:bitcoin_puzzle({"action": "list"})]
[TOOL:bitcoin_puzzle({"action": "get", "puzzleId": "puzzle-e48ef0db37fb"})]
```

## Search modes (`mode` on create)

- `random` (default) — a fresh random 12-word mnemonic every attempt. Never terminates on its own; the search space is astronomically large.
- `sequential` — walks every possible 128-bit entropy value in strict numeric order (checksum computed correctly each time), resumable. Use when the user wants an exhaustive, non-random sweep instead of random sampling.
- `partial` — the user already knows most of the phrase and only 1-2 words are missing. Pass `template` with `__` or `?` for the unknown word(s); the solver exhaustively tries every substitution for just those positions (e.g. 2048 or ~4.2M combinations, not the whole mnemonic space) and reports `status: "exhausted"` if it runs out without a match — a genuinely finite, much faster search when applicable:
```
[TOOL:bitcoin_puzzle({"action": "create", "targetAddress": "1KfZ...", "mode": "sequential"})]
[TOOL:bitcoin_puzzle({"action": "create", "targetAddress": "1KfZ...", "mode": "partial", "template": "abandon ability __ actual admit adult advance afraid again age agent about"})]
```
`get`/`list` return `mode` and, for `partial`, `combinationProgress: {index, total}` — use that for a real percentage, unlike `random`/`sequential` which have no meaningful "done" fraction.

Control:
```
[TOOL:bitcoin_puzzle({"action": "pause", "puzzleId": "puzzle-e48ef0db37fb"})]
[TOOL:bitcoin_puzzle({"action": "resume", "puzzleId": "puzzle-e48ef0db37fb"})]
[TOOL:bitcoin_puzzle({"action": "stop", "puzzleId": "puzzle-e48ef0db37fb"})]
[TOOL:bitcoin_puzzle({"action": "delete", "puzzleId": "puzzle-e48ef0db37fb"})]
```

Mark a phrase as already tried (skips it during brute force) — supports `__` or `?` as placeholders for up to 2 missing words, expanding to every combination:
```
[TOOL:bitcoin_puzzle({"action": "mark_phrase", "puzzleId": "puzzle-e48ef0db37fb", "phrase": "abandon ability __ actual admit adult advance afraid again age agent"})]
```

Check whether you already know the winning mnemonic for a puzzle — this derives the real address server-side and only marks the puzzle solved if it actually matches (never trust a claimed address):
```
[TOOL:bitcoin_puzzle({"action": "mark_found", "puzzleId": "puzzle-e48ef0db37fb", "mnemonic": "..."})]
```

Search (streamed, capped at 1000 results — a search is a UI window, not a full export):
```
[TOOL:bitcoin_puzzle({"action": "search", "puzzleId": "puzzle-e48ef0db37fb", "query": "abandon"})]
[TOOL:bitcoin_puzzle({"action": "search_all", "query": "1cryptoGeCRiTzVgxBQcKFFjSVydN1GW7"})]
[TOOL:bitcoin_puzzle({"action": "check_phrase", "phrase": "..."})]
```

Browse the raw attempts CSV page by page (no search query needed, just "show me what's in the file"):
```
[TOOL:bitcoin_puzzle({"action": "list_attempts", "puzzleId": "puzzle-e48ef0db37fb", "offset": 0, "limit": 100})]
```
Returns `{rows, count, total, hasMore}`. `offset` only grows forward for paging ("load more") — there's no index into the file, so a very deep offset on a multi-million-row puzzle streams from the start each call and gets slower the deeper you page.

- Solving is a synchronous, self-throttled loop in the SAME server process (no worker threads) — it already ran this way before the migration, so nothing changed CPU-wise. It genuinely uses one CPU core while a puzzle is running.
- There is no automatic wallet import on a find (the old core feature's auto-import to the main app database was already dead code — `setDatabase()` was never called). Tell the user to manually import a found mnemonic into their wallet if `mark_found`/a `found` state reports a match.
- `attempts_dir`/`wordlist_path` in this plugin's settings default to the exact paths the old core feature used, so puzzles created before this migration keep working unmodified.
