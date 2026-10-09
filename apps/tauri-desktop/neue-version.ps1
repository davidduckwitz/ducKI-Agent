<#
  Neue Version bauen und Update vorbereiten - fragt nur Versionsnummer und Hinweistext ab.
  Aufruf: .\neue-version.ps1   oder   .\neue-version.ps1 -Version 1.0.1 -Notes "Text"   oder Doppelklick auf neue-version.cmd
#>
param([string] $Version, [string] $Notes)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$current = ([regex]::Match([IO.File]::ReadAllText("$PSScriptRoot\package.json"), '"version":\s*"([^"]+)"')).Groups[1].Value
$p = $current.Split('.')
$suggest = "$($p[0]).$($p[1]).$([int]$p[2] + 1)"
Write-Host "DucKI Node - neue Version bauen (aktuell: $current)" -ForegroundColor Green
if (-not $Version) { $in = Read-Host "Neue Versionsnummer [$suggest]"; $Version = if ($in.Trim()) { $in.Trim() } else { $suggest } }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Ungueltige Version '$Version'." }
if ([version]$Version -le [version]$current -and (Read-Host "Version $Version ist nicht neuer als $current - fortfahren? (j/N)") -notmatch '^[jJyY]') { exit 1 }
if (-not $Notes) { $Notes = (Read-Host 'Hinweistext (was ist neu?)').Trim() }
if (-not $Notes) { throw 'Ein Hinweistext ist erforderlich.' }
& "$PSScriptRoot\release.ps1" -Version $Version -Notes $Notes
