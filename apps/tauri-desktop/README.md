# DucKI Node – Tauri Desktop App

Windows-Desktop-App (Tauri 2), die den gebündelten Agent-Server (Node-Sidecar) und die Web-UI
(`apps/web`) in einer Installation ausliefert.

## Ablauf für Nutzer

1. **Installer (NSIS)**: Installation pro Benutzer, ohne Admin-Rechte, Sprache DE/EN, eigenes
   Branding mit der Ente (`src-tauri/installer/*.bmp`). Fehlt WebView2, wird es automatisch
   nachinstalliert.
2. **Splashscreen** (`apps/web/public/desktop-splash.html`): Die Ente schwimmt, während
   Migration → Skills/Plugins → Agent-Start mit Fortschritt laufen. Dazu wechseln Feature- und
   Use-Case-Karten (Memory, LLM-Wiki, Skills, Plugins, Coding-Agent, Voice, …). Bei einem Fehler
   zeigt er Details sowie die Buttons „Erneut versuchen“, „Logs öffnen“ und „Beenden“.
3. **Setup-Assistent** (erster Start oder Tray/Menü → „Setup-Assistent …“): Darstellung, LLM-Provider
   mit Verbindungstest und Modell-Liste, Backend, Connectors, Plugins, Features (Coding, Wiki,
   Voice), Agent & Skills (inklusive Skill-Import) sowie Desktop-Optionen (Autostart, Tray, Splash,
   Ordner).

## Architektur (`src-tauri/src`)

| Modul | Aufgabe |
|---|---|
| `main.rs` | Plugins (single-instance, log, shell, opener, notification, autostart), Setup, Exit-Handling |
| `startup.rs` | Startsequenz, Fortschritt (`startup://progress`), Splash- und Hauptfenster |
| `backend.rs` | Port-Wahl (3001, sonst freier Port), Sidecar-Start, Health-Check, sauberes Beenden, Crash-Neustart |
| `seed.rs` | Migration alter Datenordner, Seeding von Prompts/Skills/Plugins (nur bei neuem `BUILD_ID`) |
| `menu.rs` | Fenstermenü und Tray (ein gemeinsamer Handler) |
| `desktop.rs` | Desktop-Einstellungen und `invoke`-Commands für Web-UI und Splash |
| `win.rs` | Windows: Agent-Mutex und Job Object (beendet den gesamten Prozessbaum) |

Die Web-UI erfährt den tatsächlichen Agent-Port über `window.__DUCKI_DESKTOP__` (Initialization
Script, siehe `apps/web/src/lib/backendUrl.ts`). Desktop-Funktionen ruft sie über
`apps/web/src/lib/desktop.ts` auf (`window.__TAURI__`, `withGlobalTauri`).

Zum Beenden schickt die Shell `POST /api/desktop/shutdown` mit einem Token, das sie bei jedem
Start neu erzeugt (`apps/server/src/lib/desktop-shutdown.ts`). So laufen die Cleanup-Handler des
Servers. Erst danach wird das Job Object beendet.

### Pfade

| Was | Wo |
|---|---|
| Datenbank, Prompts, Einstellungen | `%LOCALAPPDATA%\DucKI Node` |
| Desktop-Logs (rotierend, 5 × 5 MB) | `%LOCALAPPDATA%\DucKI Node\logs\desktop.log` |
| Workspace, Skills, Plugins | `%USERPROFILE%\DucKI\…` |

Ausführlichere Logs: Umgebungsvariable `DUCKI_DESKTOP_LOG=debug` setzen. Dann landet auch die
stdout-Ausgabe des Servers im Log.

## Entwicklung

Voraussetzungen: Rust ≥ 1.77.2 (rustup), Visual Studio Build Tools (C++), Node + pnpm sowie
ein portables `node.exe` unter `src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`.

```bash
pnpm --filter @ducki/web dev          # Vite auf :5173 (devUrl)
pnpm --filter @ducki/tauri-desktop dev
```

Läuft bereits ein DucKI-Server auf Port 3001, verbindet sich die App mit ihm.

```bash
pnpm --filter @ducki/tauri-desktop check   # cargo clippy -D warnings
pnpm --filter @ducki/tauri-desktop art     # Installer-Bitmaps neu erzeugen
```

## Release-Build

```bash
pnpm tauri:build    # = web + server bauen, build:prep, tauri build
```

Ergebnis: `src-tauri/target/release/bundle/nsis/DucKI Node_<version>_x64-setup.exe`.
Die Version kommt aus `package.json` (`tauri.conf.json` → `"version": "../package.json"`).

## Auto-Update

Die App prüft beim Start (abschaltbar im Setup-Assistenten) und über Tray/Menü „Nach Updates
suchen …“ `https://ducki.cloud/updates/desktop/latest.json`. Bei einer neueren Version zeigt die
Web-UI ein Banner (`DesktopUpdateBanner`); erst der Klick startet `install_update`
(`src-tauri/src/updater.rs`): Download → Agent stoppen → Datensicherung nach
`%LOCALAPPDATA%\DucKI Node\backups\vor-update-<Version>` → signierter NSIS-Installer (passiv) →
Neustart der App. Der Agent muss vor dem Installer stoppen, weil `node.exe` im Installationsordner läuft.

Release: `neue-version.cmd` (oder `release.ps1 -Version 1.0.1 -Notes "…"`), danach `update-server/`
hochladen – siehe `update-server/ANLEITUNG.md`. Der private Schlüssel `signing/ducki-desktop.key`
ist nicht im Git: **Backup anlegen**, sonst sind keine Updates mehr möglich.
