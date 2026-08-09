---
name: git-operations
description: Safe and effective Git workflows - status, commits, branches, and pushes with best practices for clean version control. Use for any Git or version-control task.
---

# Skill: Git Operations

## Summary
Safe and effective Git workflows. Commits, branches, pushes - all with best practices for clean version control and collaborative work.

## Core functions

### 1. Check status
```
[TOOL:git({"action": "status"})]
```

**When to use:**
- ALWAYS before commits/pushes
- To see what changed
- Find unexpected files
- Check branch status

**Workflow:**
```
[TOOL:git({"action": "status"})]
// Check: Which files changed? Untracked files? Branch?
// ONLY THEN commit/push!
```

### 2. Stage changes (add)
```
[TOOL:git({"action": "add", "files": ["src/main.ts", "src/utils.ts"]})]
```

**When to use:**
- Prepare specific files for a commit
- NOT all files together (never `git add .`!)
- Stage logical groups together

⚠️ **IMPORTANT:**
- Always name specific files!
- Do not accidentally stage secrets/credentials!
- Check staged files before commit!

### 3. Create a commit
```
[TOOL:git({"action": "commit", "message": "Fix: authentication timeout issue\n\nDetails of the fix..."})]
```

**When to use:**
- After making logical changes
- Write good commit messages
- Commit regularly (not only at the end)

**Commit message format:**
```
[Type]: [Short description]

[Longer explanation if needed]
```

Types: `fix:`, `feat:`, `refactor:`, `docs:`, `test:`, `chore:`

**GOOD commits:**
```
fix: handle null pointer in user authentication

When user logs in without complete profile data,
the system was throwing an unhandled exception.
This fix gracefully handles missing fields.
```

**BAD commits:**
```
update
fixed stuff
bug fixes and improvements
```

### 4. Create a branch
```
[TOOL:git({"action": "branch", "name": "feature/new-auth-system"})]
```

**When to use:**
- For new features: `feature/name`
- For fixes: `fix/description`
- For experiments: `experiment/idea`

**Branch naming:**
- `feature/` - new features
- `fix/` - bug fixes
- `refactor/` - code refactors
- `docs/` - documentation
- `test/` - test improvements

### 5. Switch branch
```
[TOOL:git({"action": "checkout", "branch": "feature/new-feature"})]
```

**When to use:**
- Navigate between branches
- Start feature branches
- Switch back to main

⚠️ **WARNING:**
- Check for uncommitted changes!
- Do not switch over uncommitted work
- `git status` before checkout!

### 6. Push to remote
```
[TOOL:git({"action": "push", "branch": "feature/my-feature"})]
```

**When to use:**
- Sync local commits to the remote
- Back up your work to the cloud
- So others can review the code

**Safe workflow:**
```
[TOOL:git({"action": "status"})]                    // Check status
[TOOL:git({"action": "add", "files": [...]})]       // Stage files
[TOOL:git({"action": "commit", "message": "..."})]  // Commit
[TOOL:git({"action": "push", "branch": "..."})]     // Push
```

### 7. Pull from remote
```
[TOOL:git({"action": "pull", "branch": "main"})]
```

**When to use:**
- Fetch changes from teammates
- Sync main with main
- Before creating new branches

### 8. Perform a merge
```
[TOOL:git({"action": "merge", "source": "feature/complete-feature", "into": "main"})]
```

**When to use:**
- Merge feature branches into main
- After code review is complete
- Pull request merged

⚠️ **CAUTION:**
- Merge conflicts are possible
- Test before merging!
- Always code-review beforehand

### 9. View commits
```
[TOOL:git({"action": "log", "limit": 10})]
```

**When to use:**
- Understand the history
- See recent commits
- Read commit messages
- Who changed what

### 10. View changes
```
[TOOL:git({"action": "diff"})]
```

**When to use:**
- See unstaged changes
- Check before commit
- What exactly changed?

## Safe Git workflow (gold standard)

```
1. [TOOL:git({"action": "status"})]
   └─ Unexpected file? Uncommitted work?

2. [TOOL:git({"action": "pull", "branch": "main"})]
   └─ Sync with main

3. [TOOL:git({"action": "branch", "name": "feature/my-work"})]
   └─ Create a feature branch

4. [TOOL:git({"action": "checkout", "branch": "feature/my-work"})]
   └─ Switch to the branch

5. [... do the work ...]
   └─ Edit code, test

6. [TOOL:git({"action": "status"})]
   └─ What changed?

7. [TOOL:git({"action": "add", "files": ["specific", "files"]})]
   └─ Stage the relevant files

8. [TOOL:git({"action": "commit", "message": "feat: implement new feature\n\nDetails..."})]
   └─ Create a logical commit

9. [TOOL:git({"action": "push", "branch": "feature/my-work"})]
   └─ Push to remote

10. [Create a pull request via web]
    └─ Request code review

11. [After review approval]
    [TOOL:git({"action": "merge", "source": "feature/my-work", "into": "main"})]
    └─ Merge into main
```

## Branching strategy

### Main branch
- ✅ Always deployable
- ✅ Only tested code
- ✅ Only via pull requests
- ❌ No direct commits to main

### Feature branches
- Naming: `feature/descriptive-name`
- Based on: `main`
- Merged into: `main` (via PR)
- Short-lived: max 1-2 weeks

### Hotfix branches
- Naming: `fix/critical-issue`
- For production bugs
- Merge quickly
- Test immediately!

## Common mistakes

❌ **Problem:** Committing all changes together
```
[TOOL:git({"action": "add", "files": ["."]})]  // NO!
[TOOL:git({"action": "commit", "message": "update"})]
```

✅ **Solution:**
```
[TOOL:git({"action": "add", "files": ["src/feature.ts", "test/feature.test.ts"]})]
[TOOL:git({"action": "commit", "message": "feat: implement feature X"})]
[TOOL:git({"action": "add", "files": ["docs/README.md"]})]
[TOOL:git({"action": "commit", "message": "docs: update README with feature X"})]
```

❌ **Problem:** Committing credentials
```
[TOOL:git({"action": "add", "files": [".env"]})]  // NO! SECRETS!
```

✅ **Solution:**
- Add `.env` to `.gitignore`
- Commit `.env.example` with dummy values
- Keep the real `.env` locally

## Merge conflicts

When a merge fails:

```
1. [TOOL:git({"action": "status"})]
   └─ See conflicted files

2. [TOOL:filesystem({"action": "read", "path": "conflicted-file.ts"})]
   └─ Inspect the conflict (<<<<<<< HEAD, =======, >>>>>>>)

3. [Resolve the conflict manually]
   └─ Choose the correct version

4. [TOOL:filesystem({"action": "write", "path": "conflicted-file.ts", "content": "..."})]
   └─ Save the resolved file

5. [TOOL:git({"action": "add", "files": ["conflicted-file.ts"]})]
   └─ Mark as resolved

6. [TOOL:git({"action": "commit", "message": "merge: resolve conflicts from main"})]
   └─ Commit the merge
```

## Performance tips

⚡ **Fast:**
- Frequent small commits
- Short branch lifetimes
- Review pull requests quickly

🐌 **Slow:**
- Huge commits
- Branches open for months
- Postponing merge conflicts

## Integration with other skills

- **filesystem:** edit code, then git commit
- **shell:** run tests, then git commit
- **skill_manage:** skills are version-controlled too!

## Critical rules

🔴 **NEVER:**
- `git push --force` (except with a reason)
- Commit secrets/credentials
- Leave uncommitted work un-backed-up
- Push to main without tests

🟢 **ALWAYS:**
- `git status` before important ops
- Meaningful commit messages
- Short branches (max 2 weeks)
- Get code reviewed before merge
