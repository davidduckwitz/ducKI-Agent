# DucKI UI (Tauri) — die Web-UI als standalone Windows-Exe

Die **Web-UI als eigenständige Desktop-App**. Im Gegensatz zu den anderen beiden Tauri-Apps:

| App | Zweck | Backend |
| --- | --- | --- |
| `tauri-server` | Headless Agent (Tray, Autostart) | **bündelt & startet** den Server-Sidecar |
| `tauri-desktop` | Server **und** UI in einem Prozess | **bündelt & startet** den Server-Sidecar |
| `tauri-ui` (dieses) | **Nur die UI** — verbindet sich mit einem laufenden Agent | **kein** Sidecar, verbindet sich per HTTP/WebSocket |

## Wie es funktioniert

- Die gebaute Web-App (`apps/web/dist`) wird per `frontendDist` direkt in die Exe eingebettet.
- Die Web-App erkennt Tauri selbst (`isDesktopApp()` in `apps/web/src/lib/backendUrl.ts`) und
  spricht das Backend dann **absolut** an: `/api` → `http://localhost:3001/api`, socket.io →
  `http://localhost:3001`. Kein Proxy, kein Redirect nötig.
- Standardmäßig verbindet sich die UI mit dem Agent auf **`http://localhost:3001`** — dort
  bindet `tauri-server` / `tauri-desktop` ihren Agent. Ein anderer lokaler Port oder ein
  Remote-Backend lässt sich in der UI unter **Einstellungen → Backend** konfigurieren
  (wird in `localStorage` unter `backend-config` gespeichert).
- CORS ist serverseitig offen (`origin: "*"`, reflektiert bei `credentials`), inkl.
  Private-Network-Access-Header — die embedded WebView kann das Backend cross-origin erreichen.

## Build (Windows, standalone .exe)

```bash
# 1. Web-UI bauen (falls noch nicht geschehen)
pnpm build:web

# 2. Tauri-Bundle bauen → dist/DucKI UI Setup 0.1.0.exe + portable
cd apps/tauri-ui
pnpm dist          # = pnpm -w build:web && node build.js && tauri build
```

Oder aus dem Root:

```bash
pnpm tauri:ui:build
```

## Entwicklung

```bash
# Terminal 1: Web-UI + Backend-Dev-Server (Vite :5173, API :3001)
pnpm dev

# Terminal 2: Tauri-UI im Dev-Modus (öffnet die laufende Web-App in einem Tauri-Fenster)
pnpm tauri:ui:dev
```

`tauri dev` zeigt die Web-App unter `http://localhost:5173` im Tauri-Fenster — die App erkennt
den Tauri-Runtime und nutzt absolute Backend-URLs (`http://localhost:3001/api`).

## Bekannte Grenzen

- Die App bündelt **keinen** Server — ohne laufenden Agent (tauri-server/tauri-desktop oder
  Remote-Backend) zeigt die UI Verbindungsfehler. Das ist gewollt (reine UI-Client-Rolle).
- `window.open`-Aufrufe der Web-App auf externe/absolute HTTP-URLs öffnen den Systembrowser
  (via `tauri-plugin-shell` + `shell:allow-open`).
