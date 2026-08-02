# DucKI Node - Tauri Desktop App

Moderne, unabhängige Desktop-Anwendung basierend auf Tauri (statt Electron).

## Struktur

```
tauri-desktop/
├── src/                    # Frontend TypeScript/Vite
│   ├── main.ts            # Entry point
│   └── index.html         # HTML template
├── src-tauri/             # Rust/Tauri backend
│   ├── src/main.rs        # Rust entry point (startet Backend-Server)
│   └── Cargo.toml         # Rust dependencies
├── build.js               # Build-Script für Vorbereitung
├── tauri.conf.json        # Tauri Konfiguration
└── package.json           # Node dependencies
```

## Voraussetzungen

### Windows

1. **Node.js + pnpm** (sollte bereits vorhanden sein)
2. **Rust Toolchain** - [rustup.rs](https://rustup.rs/) instalieren
3. **Visual Studio Build Tools** - erforderlich für die Rust-Compilation

Schnelle Installation (PowerShell als Admin):

```powershell
# Rust installieren
irm https://rustup.rs -outfile rustup-init.exe
.\rustup-init.exe

# Visual Studio Build Tools (optional, aber empfohlen)
# Oder: Visual Studio mit C++-Workload installieren
```

## Workflow

Die Tauri-App ist **vollständig unabhängig** von `pnpm dev`:

### Entwicklung mit Tauri

```bash
cd apps/tauri-desktop
pnpm install          # Dependencies installieren
pnpm dev              # Tauri dev mode starten
```

Das startet:
- Vite dev server auf http://localhost:5173
- Tauri App mit Hot Reload
- Backend-Server automatisch

### Bestehender Workflow bleibt unverändert

```bash
# Im Root-Verzeichnis
pnpm dev              # Startet web + server mit bestehenden Konfigurationen
```

### Production Build

```bash
cd apps/tauri-desktop
pnpm install          # Abhängigkeiten sicherstellen
pnpm dist             # Erstellt portable .exe + NSIS Installer
```

Output:
- `dist/DucKI Node 0.1.0.exe` - portable App
- `dist/DucKI Node Setup 0.1.0.exe` - Installer

## Features

✅ Unabhängig von pnpm dev Workflow  
✅ Kleinere Binary (~50-100 MB vs 170+ MB Electron)  
✅ Bessere Performance  
✅ Native Windows Integration  
✅ Automatischer Backend-Server Start  
✅ Fallback zu Remote-Backend möglich  

## Troubleshooting

### "Rust not found"
→ Rust toolchain installieren: https://rustup.rs/

### "Backend failed to start"
→ Check logs in `%APPDATA%\DucKI Node\logs\`

### "pnpm dev" zeigt merkwürdige Fehler
→ Das ist normal - die Tauri-App und pnpm dev sind voneinander unabhängig
