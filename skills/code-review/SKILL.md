---
name: code-review
description: "Structured review mode: findings-first, ordered by severity, with concrete file references."
related_skills: [plan, test-driven-development, history-search]

primary_skills: [test-driven-development]
fallback_skills: [plan, history-search]
version: 1.0.0
source: "Inspired by Hermes review/reporting conventions"
---

# Code Review Mode

## Goal
Assess changes for correctness, risk, and maintainability. Focus on real findings rather than a summary.

## Prioritization
- Critical: data loss, security, hard runtime errors.
- High: functional regressions, API breaks.
- Medium: robust error handling, edge cases.
- Low: style, readability, minor improvements.

## Output
1. Findings (by severity, with a file reference).
2. Open questions / assumptions.
3. Short change summary.

## Minimum checks
- Affected tests present and meaningful?
- Backward compatibility intact?
- Configuration and defaults consistent?

## Skill Interop

- Use `plan` to validate the review expectation against the planned scope.
- Use `test-driven-development` to ensure findings are reproduced in a testable way.
- For historical regressions, bring in `history-search` to compare known failure patterns.


