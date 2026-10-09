# Update-Server (ducki.cloud)

Dieser Ordner enthaelt die Dateien, die nach `https://ducki.cloud/updates/desktop/` hochgeladen werden.
`release.ps1` befuellt ihn bei jedem Release (nur die aktuelle Version).

| Datei | Zweck |
|---|---|
| `DucKI-Node_<Version>_x64-setup.exe` | Installer (das Update) |
| `...setup.exe.sig` | Signatur; die App lehnt Updates ohne passende Signatur ab |
| `latest.json` | Verweist auf die neueste Version; nur diese Datei fragt die App ab |

## Release
1. `neue-version.cmd` (Doppelklick) oder `.\neue-version.ps1 -Version 1.0.1 -Notes "Text"`.
2. Hochladen nach `ducki.cloud/updates/desktop/`: erst Installer + `.sig`, **zuletzt** `latest.json`.
3. Kontrolle: `https://ducki.cloud/updates/desktop/latest.json` im Browser oeffnen.

## Wichtig
- Nur HTTPS, ohne Login abrufbar; `latest.json` als `application/json`.
- Privater Schluessel `signing/ducki-desktop.key` nie committen/hochladen. **Backup ausserhalb des Repos** - ohne ihn sind keine Updates mehr moeglich (und der Public Key steckt in jeder installierten App).
- Version steht in `package.json` (+ `Cargo.toml`); das Skript setzt beides.
