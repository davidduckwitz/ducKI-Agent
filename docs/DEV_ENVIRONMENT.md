# Dev-Umgebung (Backend :3001 / Web :5173)

Praktische Referenz für lokale Sitzungen: was wo läuft, wie man es startet und welche
Fallstricke die Umgebung hat. Grundlegende Start-Schritte stehen auch im `README.md`
(„Getting Started"), hier geht es um die Details, die man nur beim Arbeiten am Code kennt.

## Überblick

| Komponente | Pfad | Port | Zweck |
| --- | --- | --- | --- |
| Backend (API + Socket.IO) | `apps/server` | **3001** (`PORT`) | Express-REST-API, Socket.IO-Events, DB-Zugriff |
| Web-UI (Vite-Dev-Server) | `apps/web` | **5173** (`VITE_PORT`) | React-UI; proxied `/api` und `/socket.io` an den Backend |
| Shared-Paket | `packages/shared` | — | wird von `pnpm dev` einmal gebaut, dann im Watch-Modus |

Der Vite-Dev-Server **und** der Preview-Server (`vite preview`) proxen `/api` und
`/socket.io` (mit `ws: true`) an den Backend — siehe `apps/web/vite.config.ts`.
Die Web-UI spricht also immer relative Pfade auf ihrem eigenen Origin, nie direkt den
Backend.

## Starten

### Alles zusammen (Standard)

```bash
pnpm dev
```

`dev.js` baut zuerst `@ducki/shared`, startet es im Watch-Modus und dann alle Pakete
parallel (mit `VITE_API_PROXY_TARGET=http://127.0.0.1:3001`).

### Backend einzeln

```bash
cd apps/server
PORT=3001 HOST=127.0.0.1 npx tsx src/index.ts
```

**Wichtig:** den Server **aus `apps/server`** starten (siehe „DB-Pfad-Falle" unten).

### Web-UI einzeln (wenn der Backend schon läuft)

```bash
cd apps/web
npx vite
```

- Anderer Proxy-Target: `VITE_API_PROXY_TARGET=http://127.0.0.1:3001` (Default `http://localhost:3001`).
- Anderer Port: `VITE_PORT=5174`.

## Fallstricke (aus der Praxis)

### 1. `PORT=0`-Falle der Shell → Backend bindet Ephemeral-Port

In manchen Shell-/Agent-Umgebungen ist die Umgebungsvariable `PORT=0` gesetzt.
Der Backend nutzt `process.env.PORT ?? "3001"` → er bindet dann **Port 0** (zufälliger
freier Port). Symptom im Log:

```
[Server] Server started {"apiUrl":"http://127.0.0.1:0", ...}
```

Dann erreicht weder der Vite-Proxy noch `curl http://127.0.0.1:3001/...` den Server.

**Fix:** explizit setzen:

```bash
PORT=3001 HOST=127.0.0.1 npx tsx src/index.ts
```

Hinweis: Die Falle betrifft nur den Backend. Vite liest `VITE_PORT` (nicht `PORT`),
startet also auch mit `PORT=0` in der Umgebung korrekt auf 5173.

### 2. DB-Pfad-Falle → Server muss aus `apps/server` laufen

Der DB-Pfad ist **relativ zur Arbeitsverzeichnis** des Server-Prozesses
(`DATABASE_PATH`, Default `./storage/ducki.db` → `apps/server/storage/ducki.db`).
Wird der Server aus einem anderen Verzeichnis gestartet, legt er eine **neue, leere
DB** an (im Repo-Root liegt z. B. eine 0-Byte-`storage/ducki.db`) — Einstellungen,
Chats und Projekte wirken dann „verschwunden".

**Fix:** `cd apps/server` vor dem Start. Die echte Entwicklungs-DB ist
`apps/server/storage/ducki.db` (WAL-Modus, `ducki.db-wal`/-`shm` daneben sind normal).

### 3. Vite-Config-Schattenwurf (`vite.config.js` vor `vite.config.ts`) — behoben

Vite löst Configs in dieser Reihenfolge auf: `vite.config.js` **vor** `vite.config.ts`.
`tsc -b` (Web-Build) hat früher eine kompilierte `vite.config.js` neben die `.ts`-Datei
emittiert — die dann **stillschweigend** die aktuelle `.ts`-Config überschattete und z. B.
den `/socket.io`-Proxy aus früheren Config-Ständen verlor.

Der Zustand ist dauerhaft behoben:

- `apps/web/tsconfig.node.json` setzt `"emitDeclarationOnly": true` → `tsc -b` emittiert
  keine `vite.config.js` mehr (nur noch die ignorierte `.d.ts`).
- `vite.config.js`, `vite.config.d.ts` und `vite.config.*.timestamp-*.mjs` sind aus dem
  Repo entfernt und in der Root-`.gitignore` gelistet.
- **`apps/web/vite.config.ts` ist die einzige Quelle.** Sie nicht durch eine neu
  generierte `.js`-Datei ersetzen und die Artefakte nicht wieder committen.

Die `.timestamp-*.mjs`-Dateien sind Vite-Temp-Bundles, die beim Laden einer `.ts`-Config
entstehen (nur für `.ts`, nicht für `.js`-Configs) und nie committet werden dürfen.

### 4. socket.io-Verbindung (WebSocket + Polling-Fallback)

- Die App verbindet sich im Dev-Modus über den **Seiten-Origin** (`getSocketUrl()` gibt
  `undefined` zurück, außer `VITE_SOCKET_URL` ist gesetzt) → `ws://<host>:5173/socket.io`
  → Vite-Proxy → Backend :3001. So funktioniert die UI auch über Tailscale/Netzwerk.
- Client-Optionen (`apps/web/src/lib/store.ts`): `transports: ["websocket", "polling"]`
  mit gebremstem Reconnect (Backoff 1–15 s).
- Der Backend-Socket.IO erlaubt alle Origins (`cors: { origin: "*" }`).

**Verifikation** (Backend auf :3001, Vite auf :5173):

```bash
# Health
curl http://127.0.0.1:3001/api/health

# socket.io-Handshake (Polling) durch den Vite-Proxy
curl "http://127.0.0.1:5173/socket.io/?EIO=4&transport=polling"
# → 0{"sid":"...","upgrades":["websocket"],...}

# WebSocket-Upgrade durch den Vite-Proxy (Antwort muss 101 sein)
node -e "const W=require('ws');const w=new W('ws://127.0.0.1:5173/socket.io/?EIO=4&transport=websocket');w.on('message',d=>{console.log('OK',d.toString().slice(0,40));w.close();});w.on('error',e=>{console.log('ERR',e.message);process.exit(1);});"
```

**Bekannte, harmlose Warnung:** Beim Seiten-Boot kann im Browser-Console gelegentlich
`WebSocket connection to 'ws://.../socket.io/...' failed: WebSocket is closed before the
connection is established` erscheinen. Das ist ein Race beim Laden — die App verbindet
sofort über den Polling-Fallback/Reconnect weiter (Server-Log „Client ready", UI
„WebSocket: Verbunden"). Eine frische Verbindung mit denselben Optionen läuft sauber per
WebSocket; das ist **kein** Config- oder Proxy-Fehler.

## Browser-Steuerung & UI-Testing (`browser`-Tool)

Das `browser`-Tool (Puppeteer-core, worker-isoliert, Session-Reuse) kann Seiten öffnen,
steuern **und testen**. Die Erweiterung hat vier Bausteine ergänzt, die für agentisches
Browser-Testing entscheidend sind:

| Baustein | Actions | Zweck |
| --- | --- | --- |
| **Element-Baum** | `snapshot` | Interaktive Elemente mit Rolle, zugänglichem Namen und deterministischem CSS-Selektor auflisten (funktioniert **ohne** Vision-Modell) |
| **Textbasiertes Steuern** | `click`/`hover` (`text`+`role`), `type`/`select`/`upload` (`target`) | Elemente über ihren sichtbaren Namen ansprechen statt CSS-Selektoren zu raten |
| **Assertions** | `expect` | Bedingungen pollen, bis sie passen oder das Timeout abläuft (`passed: true/false`) |
| **Fehler-Erfassung** | `get_page_errors` | Console-Fehler, page errors und fehlgeschlagene Requests pro Session (mit `clear` zurücksetzbar) |

Zusätzlich: `hover`, `drag_drop` (Maus oder `html5:true`), `select` (per `value` oder
sichtbarem Options-Label), `upload` (`filePaths`), `switch_tab` (`index`/`urlPart`),
`frame`-Parameter (Aktionen in iframes) und `exact` (exakter Namensabgleich).

### Empfohlener Arbeitsablauf für das Modell

1. `launch` (mit `url`) oder `goto` → **`snapshot`**, um zu sehen, was auf der Seite ist.
2. **Textbasiert** klicken/tippen: `click { text: "Speichern" }`, `type { target: "Name", text: "Max" }`.
3. **Verifizieren**: `expect { condition: "text_visible", text: "Gespeichert" }`.
4. **Fehler prüfen**: `get_page_errors` (oder `expect { condition: "no_page_errors" }`).

### Beispiel-Prompts (so kann das Modell angeleitet werden)

```text
Öffne https://example.com/login im Browser und teste den Login-Flow:
1. launch mit url, dann snapshot (Welche Felder und Buttons gibt es?)
2. type target "Benutzername" text "demo", type target "Passwort" text "geheim"
3. click text "Anmelden"
4. expect text_visible "Willkommen" (Timeout 10s)
5. get_page_errors - wenn Fehler da sind, fasse sie zusammen
```

```text
Prüfe mit dem browser-Tool, ob die Seite nach dem Klick auf "Zum Warenkorb"
einen sichtbaren Hinweis zeigt und keine JS-Fehler im Console wirft.
Nutze snapshot, um die echten Namen der Elemente zu finden, statt Selektoren zu raten.
```

**Tipp:** `snapshot` ersetzt das Raten von CSS-Selektoren — das Modell sollte immer erst
`snapshot` aufrufen und dann mit `text`/`target` interagieren. Screenshots (`screenshot`)
brauchen zusätzlich ein Vision-Modell; `snapshot` und `expect` funktionieren ohne.

## Skill-System: Core- vs. Plugin-Skills

Skills existieren in **zwei getrennten Welten** — niemals duplizieren:

**1. Core-Skills** (zwei getrackte, synchron zu haltende Kopien, aktuell je 32):

| Kopie | Pfad | Wer nutzt sie? |
| --- | --- | --- |
| Root | `./skills` | Agent pro Lauf (`loadSkillManifests`: `SKILLS_PATH` ?? `../../skills`), Validator (`node scripts/validate-skills.mjs`), Skills-Routen (Disk-Read) |
| Laufzeit | `apps/server/skills` | Statischer `SkillRegistry`-Singleton (Modul-Load) → speist `/api/skills` |

Änderungen an Core-Skills gehören in **beide** Kopien (danach `diff -q` je `SKILL.md` prüfen).

**2. Plugin-Skills** (leben NUR im Plugin, nie im Core):

- Pfad: `apps/server/plugins/<plugin>/skills/<skill>/SKILL.md`, deklariert in `plugin.json` unter `provides.skills`.
- Laufzeit-Load: `listPluginSkillDirs()` scannt nur **enabled** Plugins (beachtet `plugins/.state.json` → `disabled`-Liste); der Agent merged die Verzeichnisse pro Lauf in seinen Pool (`loadSkillManifestsUncached`).
- **Merge-Regel: Core gewinnt bei Slug-Clash** (`if (result.some(s => s.slug === slug)) continue`). Ein veraltetes Core-Duplikat (z. B. `discord` v1.2.0 im Core vs. v2.0.0 im Plugin) **überschattet die neuere Plugin-Version** — genau deshalb wurden die Core-Duplikate `discord` und `btc-puzzle-solver` entfernt.

**Konsequenzen für künftige Sitzungen:**

- Der `discord`-Skill existiert **nur noch** als Plugin-Skill (`plugins/discord-connector/skills/discord/SKILL.md`). `GET /api/skills/discord` → **404 ist erwartet und korrekt** — der Agent-Pool enthält `discord` trotzdem über den Plugin-Merge.
- Core-Änderungen am `SkillRegistry`-Singleton (z. B. `/api/skills`) brauchen einen **Server-Neustart**; der Agent-Pool liest pro Lauf vom Disk (mtime-Cache) und reagiert ohne Neustart.
- Laufzeit-Verifikation des gemergten Pools (1:1-Spiegel von `listPluginSkillDirs` + Merge-Regel, aus `apps/server`-cwd): ein kleines Node-Skript, das Core-Slugs aus `../../skills` + Plugin-Slugs aus `plugins/*/skills/*` vereinigt (Plugin nur, wenn kein Core-Clash) — `discord` muss im Ergebnis enthalten sein, Quelle `plugins/discord-connector/skills/discord`.

## Troubleshooting-Tabelle

| Symptom | Ursache | Fix |
| --- | --- | --- |
| `apiUrl: http://127.0.0.1:0` im Server-Log | `PORT=0` in der Shell | `PORT=3001` explizit setzen |
| `curl :3001/api/health` → Verbindungsfehler | Server nicht gestartet oder Ephemeral-Port | Server aus `apps/server` mit `PORT=3001` starten |
| Einstellungen/Chats „weg" nach Serverstart | Falsches cwd → neue leere DB | `cd apps/server`; DB liegt in `apps/server/storage/` |
| `/socket.io` durch 5173 → leer/404 | Vite-Config ohne `/socket.io`+`ws:true` (Schattenwurf) | Sicherstellen, dass `vite.config.ts` geladen wird (keine `vite.config.js` daneben) |
| WebSocket-Upgrade → kein 101 | Backend nicht auf :3001 | Backend starten, dann Proxy erneut testen |
| Port 5173 belegt | Andere Vite-Instanz | `VITE_PORT=5174` oder Prozess beenden |
| `detect` meldet `browserAvailable: false` | Kein Chrome/Edge gefunden | `PUPPETEER_EXECUTABLE_PATH`, `CHROME_BIN` oder `EDGE_BIN` setzen |
| `click { text: "..." }` → Element not found | Name stimmt nicht oder Element versteckt | Erst `snapshot` aufrufen und Namen daraus übernehmen |
| Skill wirkt veraltet / doppelt (z. B. `discord`) | Core-Duplikat eines Plugin-Skills überschattet die Plugin-Version (Core gewinnt) | Core-Kopie entfernen; die aktuelle Version lebt im Plugin (`plugins/<plugin>/skills/<skill>`) |
