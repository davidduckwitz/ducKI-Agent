<#
  DucKI Agent — Universal Installer (Windows 10/11, PowerShell 5.1+)
  -----------------------------------------------------------------
  Erst-Installation UND Reparatur:
    - installiert Voraussetzungen via winget (git, Node LTS, pnpm via corepack)
    - klont/aktualisiert das Repository
    - installiert Dependencies und baut das Projekt

  One-Liner (Bootstrap) in einer PowerShell:
    irm https://ducki-ai-agent.davidduckwitz.de/install/install.ps1 | iex

  Parameter (oder als Env-Var DUCKI_REPO / DUCKI_BRANCH / DUCKI_DIR):
    -Repo    Repo-URL   (Default: https://github.com/davidduckwitz/ducKI-Agent)
    -Branch  Branch     (Default: main)
    -Dir     Zielordner (Default: %USERPROFILE%\ducki-agent)
#>
[CmdletBinding()]
param(
  [string]$Repo   = $(if ($env:DUCKI_REPO)   { $env:DUCKI_REPO }   else { "https://github.com/davidduckwitz/ducKI-Agent" }),
  [string]$Branch = $(if ($env:DUCKI_BRANCH) { $env:DUCKI_BRANCH } else { "main" }),
  [string]$Dir    = $(if ($env:DUCKI_DIR)    { $env:DUCKI_DIR }    else { Join-Path $env:USERPROFILE "ducki-agent" })
)

$ErrorActionPreference = "Stop"
function Say  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok   ($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  !   $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "  X   $m" -ForegroundColor Red; exit 1 }
function Has  ($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

Write-Host ""
Write-Host "  DucKI Agent Installer (Windows)" -ForegroundColor White
Write-Host ""

if (-not (Has "winget")) { Warn "winget nicht gefunden — bitte Git/Node manuell installieren, dann Skript erneut ausfuehren." }

# ---- 1) git ----------------------------------------------------------
Say "Pruefe git"
if (Has "git") { Ok "git vorhanden" }
elseif (Has "winget") { winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements; Ok "git installiert" }
else { Die "git fehlt und winget nicht verfuegbar." }

# ---- 2) Node.js LTS (>= 20) -----------------------------------------
Say "Pruefe Node.js (>= 20)"
$nodeOk = $false
if (Has "node") { try { $nodeOk = ([int](node -v).TrimStart("v").Split(".")[0] -ge 20) } catch {} }
if ($nodeOk) { Ok "Node $(node -v)" }
elseif (Has "winget") { winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements; Ok "Node LTS installiert" }
else { Die "Node >= 20 fehlt. Bitte von https://nodejs.org installieren." }

# PATH im aktuellen Prozess auffrischen (winget-Installs sonst erst nach Neustart sichtbar)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# ---- 3) pnpm via corepack -------------------------------------------
Say "Pruefe pnpm (>= 9)"
if (-not (Has "pnpm")) {
  if (Has "corepack") { corepack enable; corepack prepare pnpm@latest --activate }
  else { npm install -g pnpm }
}
if (Has "pnpm") { Ok "pnpm $(pnpm -v)" } else { Die "pnpm-Installation fehlgeschlagen." }

# ---- 4) Repo klonen / aktualisieren ---------------------------------
if (Test-Path (Join-Path $Dir ".git")) {
  Say "Vorhandene Installation → aktualisiere ($Dir)"
  git -C $Dir fetch origin $Branch
  git -C $Dir checkout $Branch
  git -C $Dir pull --ff-only origin $Branch
} else {
  Say "Klone $Repo ($Branch) → $Dir"
  git clone --branch $Branch --depth 1 $Repo $Dir
}
Ok "Quellcode bereit"

# ---- 5) Dependencies + Build ----------------------------------------
Set-Location $Dir
Say "Installiere Dependencies (pnpm install)"
try { pnpm install --frozen-lockfile } catch { pnpm install }
Ok "Dependencies installiert"

Say "Baue Projekt (pnpm build)"
pnpm build
Ok "Build abgeschlossen"

Write-Host ""
Write-Host "  OK  Installation abgeschlossen" -ForegroundColor Green
Write-Host "  Ordner:  $Dir"
Write-Host "  Starten: cd `"$Dir`"; pnpm dev" -ForegroundColor White
Write-Host ""
