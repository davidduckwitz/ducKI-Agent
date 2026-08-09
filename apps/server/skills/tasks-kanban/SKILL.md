---
name: tasks-kanban
description: "Robustly manages task and kanban workflows: correctly creating, starting, completing, or failing tasks."
related_skills: [plan, code-review, test-driven-development, history-search]
primary_skills: [plan]
fallback_skills: [code-review, history-search]
version: 1.1.0
---

# Tasks / Kanban Management

## Goal
Use this skill for all work where tasks in the Kanban board must be created, managed, started, completed, or marked as failed.

## Tool Contract
Use the `task` tool with these actions:
- `create`
- `list`
- `get`
- `update`
- `start`
- `complete`
- `fail`
- `delete`

Supported status values:
- `pending`
- `running`
- `completed`
- `failed`
- `cancelled`

## Core Rules
1. If the work takes longer than a direct single-sentence response, a task must exist.
2. Before starting any implementation: Set the task to `running` (`task:start`).
3. After successful implementation and verification: Set the task to `completed` (`task:complete`).
4. In case of a blocking error: Set the task to `failed` (`task:fail`) and clearly state the reason for failure.
5. Never leave a task in `running` status without active progress.
6. Do not use free-form status strings; use only the allowed values.

## Standard Workflow
1. **Check/Find**:
   - If the Task ID is known: Use `task:get`.
   - If not clear: Use `task:list` and identify the appropriate task.

2. **Create (if needed)**:
   - Create using `task:create` with a clear `title` and concise `description`.
   - Set `projectId` if the context is known.
   - Initial status is `pending`.

3. **Start**:
   - Immediately before active work begins: Use `task:start`.
   - If there are multiple sub-tasks, create a plan first, then start each sequentially.

4. **Edit/Update**:
   - Use `task:update` to modify Title, Description, Priority, or Status only as needed.
   - Only manually set status via `update` if `start/complete/fail` are not semantically appropriate.

5. **Completion**:
   - Only use `task:complete` when the Definition of Done (DoD) is reached:
     - Implementation is finished.
     - Relevant checks performed (e.g., typecheck, tests, lint).
     - Known blockers are documented or resolved.

6. **Failure**:
   - If work is technically blocked or fails reproducibly:
     - Use `task:fail`.
     - State the reason + the next sensible step.

## Decision Matrix for Completion
- `completed`: Result achieved and verified.
- `failed`: Target currently unreachable (e.g., hard build error, missing credentials, external dependency down).
- `pending`: Task is planned but not yet started.
- `running`: Task is actively being worked on.
- `cancelled`: Only use if the user or process explicitly discards the task.

## Guardrails
- No silent task transitions without user feedback.
- No deletion (`delete`) without a clear justification.
- In case of uncertainty, prefer `task:update` with a precise description over an incorrect `complete`.
- After a `fail`, never move directly to `complete` without a successful new execution.

## Recommended Response Format to User
1. Task ID and current status.
2. What was executed.
3. Result (including verification).
4. Next step or reason for completion/failure.

## Skill Interop
- Use `plan` when scope or sequence is unclear.
- Use `test-driven-development` for clean verification before `complete`.
- Use `code-review` for final checks on risky changes.
- Use `history-search` to reuse existing task patterns.
