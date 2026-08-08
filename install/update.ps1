<#
  DucKI Agent — Updater (Windows)
  -------------------------------
  Entspricht dem In-App-"Update"-Button plus Node-Nachschritte:
    git pull  ->  pnpm install  ->  pnpm build

  Aufruf im Projektordner:
    .\install\update.ps1
    .\install\update.ps1 -Dir "$env:USERPROFILE\ducki-agent"
#>
[CmdletBinding()]
param(
  [string]$Dir    = $(if ($env:DUCKI_DIR) { $env:DUCKI_DIR } else { Split-Path -Parent $PSScriptRoot }),
  [string]$Branch = $(if ($env:DUCKI_BRANCH) { $env:DUCKI_BRANCH } else { "" })
)

$ErrorActionPreference = "Stop"
function Say ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok  ($m) { Write-Host "  OK  $m" -ForegroundColor Green }

if (-not (Test-Path (Join-Path $Dir ".git"))) { Write-Host "Kein Git-Repo unter $Dir" -ForegroundColor Red; exit 1 }
Set-Location $Dir
if (-not $Branch) { $Branch = (git rev-parse --abbrev-ref HEAD).Trim() }

if ((git status --porcelain)) {
  Write-Host "Worktree nicht sauber — bitte committen oder stashen. Abbruch." -ForegroundColor Red; exit 1
}

$before = (git rev-parse --short HEAD).Trim()
Say "git pull --ff-only origin $Branch"
git fetch origin $Branch
git pull --ff-only origin $Branch
$after = (git rev-parse --short HEAD).Trim()

if ($before -eq $after) { Ok "Bereits aktuell ($after) — kein Rebuild noetig."; exit 0 }
Ok "Aktualisiert: $before -> $after"

Say "pnpm install"
try { pnpm install --frozen-lockfile } catch { pnpm install }
Ok "Dependencies aktuell"

Say "pnpm build"
pnpm build
Ok "Build abgeschlossen"

Write-Host ""
Write-Host "  OK  Update abgeschlossen ($after)" -ForegroundColor Green
Write-Host ""
