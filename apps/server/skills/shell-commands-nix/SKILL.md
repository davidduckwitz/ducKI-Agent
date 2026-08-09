---
name: shell-commands-nix
description: Run shell commands on Linux and macOS through the `shell` tool - bash/zsh syntax, safe build/test/deploy workflows, process and network inspection, and how to run multi-line scripts without breaking tool-call escaping. Use for any shell, command-line, terminal, or command-execution task on a Linux or macOS host (bash/zsh), or when the user mentions running commands, scripts, builds, or tests on Unix-like systems.
license: Proprietary. Part of the DucKI agent.
compatibility: Requires a Linux or macOS host with a POSIX shell (bash or zsh). Uses the agent's `shell` tool; multi-line script writing uses the `filesystem` tool. Not for Windows - use shell-commands-win there.
allowed-tools: shell filesystem
metadata:
  platform: linux-macos
  version: "2.0"
---

# Shell Commands (Linux / macOS)

Run shell commands on a **Linux or macOS** host safely and efficiently via the `shell` tool. Commands run in a **POSIX shell** (bash/zsh) — use Unix syntax.

## Calling the shell tool

The agent may issue tool calls two ways; both reach the same `shell` tool:

- **Native tool call (preferred when available):** just call the `shell` tool with a `command` argument. The runtime passes the arguments as structured JSON — you never hand-format the wire syntax, so nothing can be mis-escaped.
- **Text fallback:** `[TOOL:shell({"command": "ls -la"})]`

Only ONE key is required: `command` (a string). Example (text form):
```
[TOOL:shell({"command": "ls -la"})]
```

## Multi-line scripts - DO NOT cram them into `command`

A multi-line script stuffed into the JSON `command` string is the #1 cause of broken tool calls (unescaped newlines/quotes). Instead, **write a `.sh` file, then run it**. Use the `filesystem` block-write form so the script body needs no escaping:

```
[TOOL:filesystem action=write path=scripts/build.sh]
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm install
npm run build
npm test
[/TOOL]
```
Then make it executable and run it:
```
[TOOL:shell({"command": "chmod +x scripts/build.sh && ./scripts/build.sh"})]
```
For a single short command, inline `command` is fine. Reach for a script file whenever the command spans multiple lines or contains many quotes.

## Core operations (bash/zsh)

### Navigate & inspect
```bash
pwd                        # current directory
cd /path/to/project        # change directory
ls -la                     # list incl. hidden
find . -name "*.ts"        # find files
```
Chain with `&&` (run next only if the previous succeeded):
```bash
cd /proj && npm install
```

### View files
```bash
cat file.txt               # view
head -20 file.txt          # first 20 lines
tail -50 file.txt          # last 50 lines
wc -l file.txt             # line count
grep -r "TODO" src/        # recursive search
```

### Build & test
```bash
npm install
npm run build
npm test
cargo build --release
pytest tests/
```
⚠️ Always READ the output. Look for `error`, `ERR!`, `failed`, non-zero exit. Mind build times (can be minutes).

### Processes
```bash
ps aux | grep node         # find a process
kill -9 <PID>              # force-kill by PID
pkill -9 node              # kill by name (careful!)
```

### Network / ports
```bash
lsof -i :3000              # what's on port 3000
ss -tuln | grep 3000       # listening sockets (or netstat -tuln)
curl -s http://localhost:3000   # HTTP request
```

### System
```bash
df -h                      # disk space
du -sh .                   # directory size
free -h                    # RAM (Linux); macOS: vm_stat
uname -a                   # system info
```

### Environment variables
```bash
echo "$NODE_ENV"           # read
DEBUG=true npm start       # set for one command
export DEBUG=true          # set for the session
```

## Exit codes & error handling

- `$?` holds the last command's exit code (`0` = success).
- Chain conditionally: `cmd1 && cmd2` (on success), `cmd1 || cmd2` (on failure).
- In scripts, start with `set -euo pipefail` so failures stop the script instead of continuing silently.
- Redirect: `npm test > out.txt 2>&1` (stdout+stderr), `2>/dev/null` (drop errors).

## Safe workflow: build → test → commit

```
1. [TOOL:shell({"command": "pwd"})]                    # confirm the directory
2. [TOOL:shell({"command": "npm install"})]            # dependencies
3. [TOOL:shell({"command": "npm run build"})]          # build - read output
4. [TOOL:shell({"command": "npm test"})]               # tests must be green
5. Green -> safe to commit.  Red -> fix first, never commit broken tests.
```

## Best practices

✅ DO
- Read the output of every command before continuing.
- Check `$?` / look for error strings.
- Prefer a written `.sh` (with `set -euo pipefail`) for anything multi-line.
- Quote variables and paths with spaces: `"$path"`.

❌ DON'T
- Run destructive commands blindly: `rm -rf /`, `git push --force`, `sudo reboot`, `kill -9 $(pgrep node)`.
- Use `sudo` without a clear reason.
- Cram multi-line scripts into the JSON `command` string.

## Common issues

**Port already in use**
```bash
lsof -i :3000        # find the PID
kill -9 <PID>
```
**Permission denied running a script**
```bash
chmod +x scripts/build.sh && ./scripts/build.sh
```
**Build failed** — clear caches, reinstall, retry:
```bash
npm run clean && npm install && npm run build
```

## Timeouts

Long operations need patience — don't interrupt while running:
- `npm install` (large project): 5+ min
- `npm test` with coverage: 10+ min
- Full build: 15+ min

## Related

- `shell-commands-win` — the Windows counterpart (PowerShell/cmd).
- `filesystem` tool — write `.sh`/config files (use the block-write form for multi-line content).
- `git-operations` — change code, then `npm test` before commit.
