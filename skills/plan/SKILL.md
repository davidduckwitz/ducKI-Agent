---
name: plan
description: "Planning mode: actionable plan only, no direct implementation in this turn."
related_skills: [memory, history-search, llm-wiki, test-driven-development, code-review, workflow-orchestrator]
primary_skills: [memory, history-search, llm-wiki, workflow-orchestrator]
fallback_skills: [workflow-orchestrator, test-driven-development, code-review]
version: 1.0.0
source: "Inspired by https://github.com/NousResearch/hermes-agent/blob/main/skills/software-development/plan/SKILL.md"
---

# Plan Mode

## Purpose
Use this skill when the user expects a solid implementation plan and not immediate implementation.

## Rules
- No production code changes in this step.
- If needed, only read-only repo inspection.
- The result is a concrete, testable step-by-step plan.

## Plan structure
1. Goal and scope.
2. Current state and assumptions.
3. Step sequence in small tasks.
4. Affected files and interfaces.
5. Test and verification strategy.
6. Risks and open questions.

## Quality criteria
- Each task is small and unambiguous.
- File paths and commands are concrete.
- Acceptance criteria are measurable.

## Skill Interop
- Incorporate historical solutions via `history-search` into assumptions/risks.
- For knowledge/documentation parts, cite `llm-wiki` as a source in the plan.
- Plan `test-driven-development` for implementation phases and `code-review` for acceptance as downstream steps.


