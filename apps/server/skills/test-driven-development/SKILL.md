---
name: test-driven-development
description: "TDD-first implementation: red, green, refactor with explicit verification."
related_skills: [plan, history-search, code-review]

primary_skills: [plan]
fallback_skills: [history-search, code-review]
version: 1.0.0
source: "Inspired by common Hermes/OpenClaw software-dev skill patterns"
---

# TDD Mode

## Procedure
1. Write a failing test first.
2. Run the test and confirm the failure.
3. Implement the minimal code to make it green.
4. Re-run the relevant tests.
5. Refactor only with green tests.

## Requirements
- No untested production code.
- Tests must cover behavior, not internal details.
- Test data clear and reproducible.

## Output format
- Changed files
- Test commands and results
- Residual risks or uncovered cases

## Skill Interop

- If the scope is unclear, use `plan` first for clear steps.
- Before implementation, optionally use `history-search` to reuse existing test patterns.
- After a green implementation, run `code-review` as a final check.


