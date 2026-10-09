<#
  Baut einen signierten Windows-Release der DucKI-Node-Desktop-App und erzeugt die Update-Dateien.

  Aufruf:   .\release.ps1 -Version 1.0.1 -Notes "Was ist neu?"
  Ergebnis: update-server\  mit  DucKI-Node_<Version>_x64-setup.exe, .sig und latest.json
  Upload:   Inhalt nach https://ducki.cloud/updates/desktop/ (Installer + .sig zuerst, latest.json zuletzt).
  Wenig Platz auf dem Projektlaufwerk? `$env:CARGO_TARGET_DIR = 'G:\cargo-target\ducki-desktop'` setzen.
  Schluessel: signing\ducki-desktop.key (nicht im Git; Backup ausserhalb des Repos!)
#>
param(
  [Parameter(Mandatory)] [string] $Version,
  [string] $Notes = '',
  [string] $BaseUrl = 'https://ducki.cloud/updates/desktop',
  [switch] $SkipBuild
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Update-File($path, $pattern, $replacement) {
  $text = [IO.File]::ReadAllText($path, $utf8)
  [IO.File]::WriteAllText($path, [regex]::Replace($text, $pattern, $replacement), $utf8)
}

# Version setzen (tauri.conf.json liest sie aus package.json)
Update-File (Join-Path $root 'package.json') '("version":\s*)"[^"]+"' "`$1`"$Version`""
Update-File (Join-Path $root 'src-tauri\Cargo.toml') '(?m)^version = "[^"]+"' "version = `"$Version`""

$keyFile = Join-Path $root 'signing\ducki-desktop.key'
if (-not (Test-Path $keyFile)) { throw "Signierschluessel fehlt: $keyFile" }
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyFile -Raw)
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''

if (-not $SkipBuild) {
  # pnpm dist = web + server + build:prep + tauri build
  Push-Location $root
  try { pnpm dist; if ($LASTEXITCODE) { throw 'pnpm dist fehlgeschlagen' } } finally { Pop-Location }
}

$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root 'src-tauri/target' }
$bundle = Join-Path $targetDir 'release/bundle/nsis'
$exe = Get-ChildItem $bundle -Filter "*_${Version}_x64-setup.exe" | Select-Object -First 1
if (-not $exe) { throw "Installer fuer Version $Version nicht gefunden in $bundle" }
$sig = "$($exe.FullName).sig"
if (-not (Test-Path $sig)) { throw "Signatur fehlt: $sig (createUpdaterArtifacts aktiv?)" }

$out = Join-Path $root 'update-server'
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem $out -Include '*-setup.exe', '*.sig', 'latest.json' -Recurse | Remove-Item -Force
# URL-sichere Dateinamen (Leerzeichen im Produktnamen)
$safe = ($exe.Name -replace '\s+', '-')
Copy-Item $exe.FullName (Join-Path $out $safe)
Copy-Item $sig (Join-Path $out "$safe.sig")

$manifest = [ordered]@{
  version   = $Version
  notes     = $Notes
  pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = (Get-Content $sig -Raw).Trim()
      url       = "$BaseUrl/$safe"
    }
  }
}
[IO.File]::WriteAllText((Join-Path $out 'latest.json'), ($manifest | ConvertTo-Json -Depth 5), $utf8)
Write-Host "Fertig: $out" -ForegroundColor Green
Write-Host 'Hochladen: Installer + .sig zuerst, latest.json zuletzt.'
