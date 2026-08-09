---
name: shell-commands
description: Run shell commands efficiently and safely - scripts, system tasks, and processes with best practices for security and reliability. Use for shell or command-execution tasks.
---

# Skill: Shell Commands

## Summary
Run shell commands efficiently and safely. Scripts, system tasks, processes - all with best practices for security and reliability.

## Core functions

### 1. Run a single command
```
[TOOL:shell({"command": "ls -la"})]
```

**When to use:**
- Quick status checks
- List files/directories
- Check processes
- View system info

### 2. Set the working directory
```
[TOOL:shell({"command": "cd /path/to/project && npm install"})]
```

**When to use:**
- Run commands in a specific directory
- Project context for commands
- Path-dependent operations

**Best practice:**
```
[TOOL:shell({"command": "cd /home/user/my-project && pwd"})]
└─ Confirm you are in the right dir!
```

### 3. Build commands
```
[TOOL:shell({"command": "npm run build"})]
[TOOL:shell({"command": "cargo build --release"})]
[TOOL:shell({"command": "python setup.py build"})]
```

**When to use:**
- Compile the project
- Install dependencies
- Generate artifacts

⚠️ **IMPORTANT:**
- Always read the build output
- Check for errors
- Mind the build time (can take a while!)

### 4. Run tests
```
[TOOL:shell({"command": "npm test"})]
[TOOL:shell({"command": "cargo test"})]
[TOOL:shell({"command": "pytest tests/"})]
```

**When to use:**
- Test after code changes
- Regression tests
- Before pushing to the remote
- Make sure nothing is broken

**GOLDEN RULE:**
- ALWAYS test before commit/push
- Green tests = safe to commit
- Failing tests = do not commit!

### 5. Manage processes
```
[TOOL:shell({"command": "ps aux | grep node"})]
[TOOL:shell({"command": "kill -9 <PID>"})]
[TOOL:shell({"command": "lsof -i :3000"})]
```

**When to use:**
- See running processes
- Stop a server
- Check port conflicts
- Terminate debug processes

### 6. Process files
```
[TOOL:shell({"command": "find . -name '*.tmp' -delete"})]
[TOOL:shell({"command": "grep -r 'TODO' src/"})]
[TOOL:shell({"command": "wc -l src/main.ts"})]
```

**When to use:**
- Bulk operations
- Pattern search
- File statistics
- Cleanup

### 7. Environment variables
```
[TOOL:shell({"command": "echo $NODE_ENV"})]
[TOOL:shell({"command": "export DEBUG=true && npm start"})]
```

**When to use:**
- Check config
- Set dynamic values
- Environment-specific commands

### 8. Pipe & redirection
```
[TOOL:shell({"command": "npm list | grep lodash"})]
[TOOL:shell({"command": "npm test > test-results.txt 2>&1"})]
[TOOL:shell({"command": "cat config.json | jq '.database'"})]
```

**When to use:**
- Filter output
- Save results to files
- Parse & manipulate JSON
- Analyze logs

## Safe shell workflows

### Workflow 1: build & test
```
1. [TOOL:shell({"command": "cd my-project && pwd"})]
   └─ Check the dir

2. [TOOL:shell({"command": "npm install"})]
   └─ Dependencies

3. [TOOL:shell({"command": "npm run build"})]
   └─ Run the build

4. [TOOL:shell({"command": "npm test"})]
   └─ Run tests

5. [If successful: SAFE TO COMMIT]
   [If errors: FIX FIRST!]
```

### Workflow 2: deployment checklist
```
1. [TOOL:shell({"command": "git status"})]
   └─ Uncommitted? Abort!

2. [TOOL:shell({"command": "npm test"})]
   └─ Tests green?

3. [TOOL:shell({"command": "npm run build"})]
   └─ Build ok?

4. [TOOL:shell({"command": "npm run deploy"})]
   └─ Deploy to production

5. [TOOL:shell({"command": "npm run smoke-tests"})]
   └─ Verification in prod
```

## Commands by type

### Navigation
```bash
pwd                    # current directory
cd /path/to/dir       # change directory
ls -la                # list files (incl. hidden)
find . -name "*.js"   # find files
```

### Files
```bash
cat file.txt          # view a file
head -20 file.txt     # first 20 lines
tail -50 file.txt     # last 50 lines
wc -l file.txt        # line count
grep "pattern" file   # search for a pattern
```

### Processes
```bash
ps aux                 # all processes
ps aux | grep node    # find a specific process
kill -9 <PID>         # terminate a process (forceful)
jobs                   # background jobs
```

### Network
```bash
netstat -tuln | grep 3000   # check port 3000
lsof -i :3000               # what is running on port 3000?
curl http://localhost:3000  # HTTP request
```

### System
```bash
df -h                  # disk space
du -sh .               # directory size
free -h                # RAM info
uname -a               # system info
```

## Best Practices

✅ **DO:**
- Check commands beforehand
- Read the output (very important!)
- Check error codes
- Test locally first
- Enable logging for important ops

❌ **DON'T:**
- `rm -rf /` without checking (😱)
- Commands without checking the output
- Sudo without a reason
- Run destructive commands blindly
- Production commands without a backup

## Error handling

### Check the output
```
[TOOL:shell({"command": "npm install"})]
// Read the output:
// ✅ "added 123 packages"
// ❌ "ERR! code E404"
// ❌ "npm ERR!"
```

### Check the exit code
```bash
npm test ; echo $?  # 0 = success, anything else = error
```

### Redirect stderr
```bash
npm build 2>&1      # stderr + stdout together
npm build 2>/dev/null  # ignore errors (sometimes ok)
```

## Long commands

For very long or complex commands:
```
npm run build && \
npm test && \
git add . && \
git commit -m "feat: new feature"
```

Better: write a shell script
```bash
#!/bin/bash
cd /project
npm install
npm run build
npm test
```

## Performance tips

⚡ **Fast:**
- Parallel commands `npm install & npm build`
- Use caching
- Check permissions before ops

🐌 **Slow:**
- Reading large files in full
- Recursive operations on big trees
- Network commands without a timeout

## Integration with other tools

- **git:** change code, then `npm test` before commit
- **filesystem:** create files, then `npm build`
- **skill_manage:** skills are executable too!

## Critical rules

🔴 **NEVER RUN BLINDLY:**
```
rm -rf /path
git push --force
sudo reboot
kill -9 $(pgrep node)
```

🟢 **ALWAYS FIRST:**
```
Check the command
Read the output
Verify safety
Only then: run the command
```

## Common issues

### Port already in use
```
lsof -i :3000        # what is running there?
kill -9 <PID>        # kill the process
npm start             # restart
```

### Build failed
```
npm run clean        # clear cache
npm install          # fresh dependencies
npm run build        # retry
```

### Tests failing
```
npm test -- --verbose  # see details
npm test -- one-test   # run a single test
Debug + fix + retry
```

## Mind the timeout

Long operations:
- `npm install` on a large project: 5+ minutes
- `npm test` with coverage: 10+ minutes
- Build of a large project: 15+ minutes

Always budget the time, don't interrupt while it is still running!
