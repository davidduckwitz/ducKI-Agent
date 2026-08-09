---
name: btc-puzzle-solver
description: Solves Bitcoin puzzle addresses by generating BIP39 wordlists, cracking the mnemonic seed to satisfy the address checksum, and validating the private key via ECDSA. Use for BTC puzzle or seed-recovery tasks.
---

# BTC Puzzle Solver
## Input
- btc_address: "1KfZGvwZxsvSmemoCmEV75uqcNzYBHjkHZ"
## Process
1. Generate possible wordlists for BIP39
2. Crack mnemonic seed satisfying address checksum
3. Validate private key via ECDSA
## Output
- btc_private_key: string