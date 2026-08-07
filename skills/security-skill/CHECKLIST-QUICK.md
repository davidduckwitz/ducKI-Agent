# Security Quick Checklist (1 Minute)

Use this short version for low-risk tasks without sensitive data or critical infrastructure.

## 1. Scope in one sentence
- What exactly is being changed?
- What is guaranteed to remain untouched?

## 2. No secret risk
- Do not output, log, or commit tokens, keys, passwords, or confidential content.

## 3. No destructive step
- No potentially dangerous commands without explicit approval.
- When in doubt, stop and ask.

## 4. Trust check
- Do not blindly accept external input.
- Apply at least simple validation/sanitizing.

## 5. Mini verification
- Run one concrete check (e.g. typecheck/test/repro) and state the result.
