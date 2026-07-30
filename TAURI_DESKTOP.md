# DucKI Node - Tauri Desktop App

Die neue Desktop-Anwendung basiert auf **Tauri** statt Electron. Sie ist unabhängig vom bestehenden `pnpm dev` Workflow.

## Quick Start

### 1. Rust installieren (einmalig)

Lade Rust von https://rustup.rs/ herunter und installiere es.

### 2. App bauen

```bash
cd apps/tauri-desktop
pnpm install
pnpm build:prep     # Bereitet Web + Server vor
pnpm dist           # Erstellt portable .exe + Installer
```

Output:
- `dist/DucKI Node 0.1.0.exe` (portable)
- `dist/DucKI Node Setup 0.1.0.exe` (Installer)

### 3. Entwicklung

```bash
cd apps/tauri-desktop
pnpm dev            # Startet mit Tauri dev mode + hot reload
```

## Vorteile gegenüber Electron

| Feature | Electron | Tauri |
|---------|----------|-------|
| Binary Size | ~170 MB | ~50-100 MB |
| Memory | 150+ MB | <100 MB |
| Build Time | 2-3 min | 10-15 min (einmalig) |
| Dependencies | Node + Chromium | Rust (native) |
| Auto-Start | ✅ | ✅ |

## Struktur

```
apps/tauri-desktop/
├── src/                 # Frontend (Vite + TypeScript)
├── src-tauri/           # Rust backend (Tauri)
│   └── src/main.rs      # Startet Backend-Server
├── build.js             # Vorbereitung vor Build
└── tauri.conf.json      # Konfiguration
```

## Bestehender Workflow bleibt unverändert

```bash
# Im Root-Verzeichnis - funktioniert weiterhin normal
pnpm dev              # web + server mit Dev-Servern
pnpm build            # web + server für Production
```

Die Tauri-App ist **vollständig unabhängig** und nutzt nur die gebauten Artefakte.

## Backend-Integration

Die Tauri-App startet automatisch den Backend-Server (Port 3001):

- **Development**: Nutzt `node` zum Ausführen von `apps/server/dist/index.js`
- **Production**: Nutzt gebündelte `server.exe` (erstellt mit `pkg`)

Fallback: Falls der Server nicht startet, kann man sich zu einem Remote-Backend verbinden.

## Skripte

| Skript | Beschreibung |
|--------|-------------|
| `pnpm dev` | Tauri dev mode mit hot reload |
| `pnpm build:prep` | Vorbereitung (kopiert web+server) |
| `pnpm dist` | Production build (portable + installer) |
| `pnpm type-check` | TypeScript Checks |

## Troubleshooting

### `error: could not compile 'ducki-desktop'`
→ Rust nicht installiert: https://rustup.rs/

### `Backend server failed to start`
→ Logs unter `%APPDATA%\DucKI Node\logs\ducki.log`

### `Web files not found`
→ Vorher bauen: `pnpm build` in root

## Next Steps

Optionale Verbesserungen:
- [ ] Remote-Backend Option im Settings
- [ ] Auto-Updates implementieren
- [ ] System Tray Integration
- [ ] Dark Mode Support
