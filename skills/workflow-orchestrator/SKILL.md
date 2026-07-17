---
name: workflow-orchestrator
description: "Create and control workflow graphs via the workflow tool with a strict plan-build-run-resume loop."
version: 1.0.0
---

# Workflow Orchestrator

## Purpose
Use this skill when the task should be executed as a reusable workflow graph instead of an ad-hoc one-shot response.

## Primary Rule
Always prefer managing work through the workflow tool lifecycle:
1. Understand goal and constraints. (Check skill fast-answer)
2. Read Memory for help and Create or update a workflow graph.
3. Run or resume workflow execution.
4. Report status and next actions.

## Tool Contract
Use tool name `workflow` with these actions:
- `list`
- `get`
- `create`
- `update`
- `run`
- `resume`
- `delete`

## Execution Pattern

### 1) Discover
- First list existing workflows and check if one already matches the user's goal.
- If a suitable workflow exists, update it instead of creating duplicates.

### 2) Build Graph
- Ensure workflow has:
- Clear `name`
- Explicit `goal`
- Role-specialized `nodes` (`manager`, `research`, `coding`, `review`, `browser`)
- Correct dependencies via `dependsOn` and/or edges

Recommended node order:
1. Manager planning node (Check if only answer fast needed or skills needed)
2. Research node (if unknowns exist)
3. Coding/implementation node
4. Review/validation node

### 3) Run Safely
- Use `run` for fresh execution.
- Use `resume` when a workflow was partially completed.
- If run fails, inspect failed node and update prompts/dependencies before retry.

### 4) Persist and Communicate
- Persist any structural changes using `update`.
- Return concise workflow status:
- Workflow id/name
- Completed vs failed nodes
- Next best action
- Use internal Shared API to handle files

## Quality Rules
- Do not create circular dependencies.
- Keep node prompts concrete and testable.
- Prefer small, single-purpose nodes over large vague nodes.
- Reuse existing workflows where possible.

## Output Style
When reporting to user, include:
1. What workflow was used or created
2. What was executed (`run` or `resume`)
3. Current status and blockers
4. Proposed next step
