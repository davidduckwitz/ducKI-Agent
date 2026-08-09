---
name: shell-commands-win
description: Run shell commands on Windows through the `shell` tool - PowerShell and cmd.exe syntax, safe build/test/deploy workflows, process and network inspection, and how to run multi-line scripts without breaking tool-call escaping. Use for any shell, command-line, terminal, or command-execution task on a Windows host (PowerShell / cmd), or when the user mentions running commands, scripts, builds, or tests on Windows.
license: Proprietary. Part of the DucKI agent.
compatibility: Requires a Windows host (Windows 10/11) with PowerShell 5.1+ or cmd.exe. Uses the agent's `shell` tool; multi-line script writing uses the `filesystem` tool. Not for Linux/macOS - use shell-commands-nix there.
allowed-tools: shell filesystem
metadata:
  platform: windows
  version: "2.0"
---

# Shell Commands (Windows)

Run shell commands on a **Windows** host safely and efficiently via the `shell` tool. Commands run in **PowerShell** (primary) or **cmd.exe** — use Windows-native syntax, not Linux/bash.

## Calling the shell tool

The agent may issue tool calls two ways; both reach the same `shell` tool:

- **Native tool call (preferred when available):** just call the `shell` tool with a `command` argument. The runtime passes the arguments as structured JSON — you never hand-format the wire syntax, so nothing can be mis-escaped.
- **Text fallback:** `[TOOL:shell({"command": "Get-ChildItem"})]`

Only ONE key is required: `command` (a string). Example (text form):
```
[TOOL:shell({"command": "Get-ChildItem -Force"})]
```

## Multi-line scripts - DO NOT cram them into `command`

A multi-line script stuffed into the JSON `command` string is the #1 cause of broken tool calls (unescaped newlines/quotes). Instead, **write a `.ps1` file, then run it**. Use the `filesystem` block-write form so the script body needs no escaping:

```
[TOOL:filesystem action=write path=scripts/build.ps1]
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
npm install
npm run build
npm test
[/TOOL]
```
Then execute it:
```
[TOOL:shell({"command": "powershell -ExecutionPolicy Bypass -File scripts/build.ps1"})]
```
For a single short command, inline `command` is fine. Reach for a script file whenever the command spans multiple lines or contains many quotes.

## Core operations (PowerShell)

### Navigate & inspect
```powershell
Get-Location                       # current directory (pwd)
Set-Location C:\path\to\project    # change directory (cd)
Get-ChildItem -Force               # list incl. hidden (ls -la)
Get-ChildItem -Recurse -Filter *.ts   # find files
```
Set a working directory inline with `;` (PowerShell has no `&&` before v7):
```powershell
Set-Location C:\proj; npm install
```

### View files
```powershell
Get-Content file.txt               # cat
Get-Content file.txt -TotalCount 20   # head -20
Get-Content file.txt -Tail 50      # tail -50
(Get-Content file.txt | Measure-Object -Line).Lines   # wc -l
Select-String -Path src\*.ts -Pattern "TODO"          # grep
```

### Build & test
```powershell
npm install
npm run build
npm test
cargo build --release
```
⚠️ Always READ the output. Look for `error`, `ERR!`, `failed`, non-zero exit. Mind build times (can be minutes).

### Processes
```powershell
Get-Process node                   # find a process (ps | grep)
Stop-Process -Id <PID> -Force      # kill a process
Stop-Process -Name node -Force     # kill by name
```

### Network / ports
```powershell
Get-NetTCPConnection -LocalPort 3000   # what's on port 3000
Test-NetConnection localhost -Port 3000
Invoke-WebRequest http://localhost:3000 -UseBasicParsing   # HTTP request (curl)
```

### System
```powershell
Get-PSDrive C                      # disk space (df)
Get-CimInstance Win32_OperatingSystem | Select FreePhysicalMemory   # RAM
[System.Environment]::OSVersion    # system info
```

### Environment variables
```powershell
$env:NODE_ENV                      # read
$env:DEBUG = "true"; npm start     # set for the session
```

## Exit codes & error handling

- PowerShell: `$LASTEXITCODE` holds the last native program's exit code (`0` = success).
- Chain sequentially with `;`. On PowerShell 7+ you may use `&&` / `||`; on 5.1 use `; if ($?) { ... }`.
- Redirect: `npm test *> test-results.txt` (all streams), `2>$null` (drop errors).

## Safe workflow: build → test → commit

```
1. [TOOL:shell({"command": "Get-Location"})]           # confirm the directory
2. [TOOL:shell({"command": "npm install"})]            # dependencies
3. [TOOL:shell({"command": "npm run build"})]          # build - read output
4. [TOOL:shell({"command": "npm test"})]               # tests must be green
5. Green -> safe to commit.  Red -> fix first, never commit broken tests.
```

## Best practices

✅ DO
- Read the output of every command before continuing.
- Check `$LASTEXITCODE` / look for error strings.
- Prefer a written `.ps1` for anything multi-line.
- Quote paths that contain spaces: `"C:\Program Files\app.exe"`.

❌ DON'T
- Run destructive commands blindly: `Remove-Item -Recurse -Force`, `git push --force`, `Restart-Computer`.
- Assume bash — this is Windows. `ls -la`, `rm -rf`, `ps aux`, `grep`, `cat` may not behave as on Linux.
- Cram multi-line scripts into the JSON `command` string.

## Common issues

**Port already in use**
```powershell
Get-NetTCPConnection -LocalPort 3000    # find the PID
Stop-Process -Id <PID> -Force
```
**Execution policy blocks a script**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```
**Build failed** — clear caches, reinstall, retry:
```powershell
npm run clean; npm install; npm run build
```

## Timeouts

Long operations need patience — don't interrupt while running:
- `npm install` (large project): 5+ min
- `npm test` with coverage: 10+ min
- Full build: 15+ min

## Related

- `shell-commands-nix` — the Linux/macOS counterpart (bash/zsh).
- `filesystem` tool — write `.ps1`/config files (use the block-write form for multi-line content).
- `git-operations` — change code, then `npm test` before commit.
