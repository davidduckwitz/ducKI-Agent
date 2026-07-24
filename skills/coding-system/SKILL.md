---
name: coding-system
description: "Use the coding area for AI/Vibe coding with project-bound chat and file editor in shared-workspace/coding."
related_skills: [shared-workspace-ops, browser-control, test-driven-development, code-review, security-skill]
primary_skills: [shared-workspace-ops, test-driven-development, code-review, security-skill]
fallback_skills: [shared-workspace-api-first, code-review, workflow-orchestrator, security-skill]
version: 1.0.0
---

# Coding System Skill

## Goal
Use the integrated coding area for project-specific work with Chat + Editor, instead of unstructured individual file operations.

## When to Use
- When the user wants to work on features/code within a dedicated coding project.
- When AI/Vibe coding with parallel file editing is required.
- When the work should be neatly stored in `shared-workspace/coding/<project>`.

## Hard Rules
1. First, check if `CODING_ENABLED=true` is set.
2. Use coding projects as the working context; do not mix with unrelated shared paths.
3. Save files only under `shared-workspace/coding/<project>/...`.
4. Execute TDD or planning steps first.
5. Delegate tasks to subagents and wait for their results.

## Writing Discipline (Mandatory)
1. Use only relative paths within the current project for coding files.
2. Always set the following for filesystem operations:
   - `basePath: "./shared-workspace/coding/<project>"`
   - `safeMode: true`
   - `createDirs: true` (for write/append)
3. Validate every `write`/`append`/`move`/`copy` first using `dryRun: true`.
4. Verify immediately after every write operation:
   - `exists` or `stat` on the target file
   - optionally `read` for content check on text files
5. Do not use absolute paths.
6. Abort immediately on path or scope errors and revert the path to the project root.

## Minimal File Writing Pattern
1. Determine target path: relative to `shared-workspace/coding/<project>`.
2. Execute dry run (`dryRun: true`).
3. Execute write (`dryRun: false`).
4. Verify result (`exists`/`stat`/`read`).

## API Flow
1. `GET /api/coding/status`
2. `GET /api/coding/projects`
3. If necessary, `POST /api/coding/projects`
4. After that, perform file operations only under `/api/coding/projects/:project/*`

## Chat Flow
- Use a separate conversation context for each coding project.
- Always send prompts with project and workspace notes:
- `workspaceRoot=shared-workspace/coding/<project>`

## Skill Interop
- `shared-workspace-ops`: persistent file operations and structure maintenance.
- `shared-workspace-api-first`: if API parity must be strictly enforced.
- `test-driven-development`: for feature implementations with tests.
- `code-review`: final check before final handoff.
- `workflow-orchestrator`: for multi-step coding pipelines.

## Output Format
1. Project name and target path
2. Changed files
3. Chat/Implementation progress
4. Open points or next step
