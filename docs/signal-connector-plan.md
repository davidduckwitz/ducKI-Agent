# Signal-Connector Plan

Ziel: Signal-Protocol-Messaging für ducki-node + ducki.cloud (Laravel/Wave), zwei Flows:

1. **Agent ↔ User** (bidirektional, wie Discord/Telegram-Connector)
2. **User → User**: Ducki stellt den Erstkontakt her (Nummer/Gruppenlink teilen), die eigentliche
   Konversation läuft danach nativ in Signal, ohne Ducki im Loop.

Entschieden: beide Nummern-Modelle (Shared Bot-Nummer *und* Linked-Device-pro-Tenant) parallel
unterstützen, als zwei Modi desselben Plugins.

## 1. Warum kein "Bot API"-Ansatz möglich ist

Signal hat — anders als Telegram (Bot-Token) oder Discord (Bot-Token) — keine offizielle
Bot-/Business-API. Jeder Account ist ein vollwertiger Signal-Account:

- Registrierung braucht eine echte Telefonnummer + SMS/Voice-Verifizierung (bei automatisierter
  Massen-Registrierung: Captcha-Pflicht)
- Der Client muss das Signal-Protocol (Double Ratchet, X3DH, Sealed Sender) korrekt implementieren
- De-facto-Standard für Automatisierung: **[signal-cli](https://github.com/AsamK/signal-cli)**
  (Java, wrapt libsignal), läuft als Daemon mit JSON-RPC (Unix-Socket) oder wird über
  **[signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api)** (Docker, HTTP-Wrapper
  um signal-cli) angesprochen. Das ist auch die Basis fast aller bestehenden Signal-Bridges
  (z.B. mautrix-signal).

Wichtig für Erwartungsmanagement: Das ist informell geduldete Nutzung des Protokolls über einen
Drittclient, keine von Signal sanktionierte Business-API. Rate-Limits und das Risiko einer
Account-Sperre bei auffälligem Massen-Traffic sind real und müssen im Betrieb berücksichtigt
werden (siehe Abschnitt 6).

## 2. Infrastruktur-Empfehlung: signal-cli-rest-api (Docker) statt eingebettetem JSON-RPC

Zwei Optionen standen zur Wahl; Empfehlung: **Docker-Container mit `signal-cli-rest-api`,
per HTTP von ducki-node angesprochen** — aus denselben Gründen, die den bestehenden
Connectors zugrunde liegen:

| | signal-cli-rest-api (Docker, HTTP) | signal-cli JSON-RPC (eingebetteter Java-Prozess) |
|---|---|---|
| Node-seitiger Aufwand | Niedrig — `fetch()` wie telegram-connector | Hoch — Java-Subprozess-Lifecycle, Socket-Handling, JVM-Startup/Crash-Recovery in Node |
| Isolation | Sauber getrennter Prozess/Container, crasht nicht den Node-Host | JVM-Crash reißt ggf. den Node-Host-Prozess mit |
| Multi-Device/Multi-Account | Container unterstützt mehrere Accounts nativ (`/v1/accounts`) | Müsste man selbst bauen |
| Deploy-Modell | Passt zu "Shared-Tenant per-User-Dirs, kein Container" aus [[saas-cloud-agent-project]] — **ein** zentraler Container reicht für Shared-Bot-Modus; pro-Tenant-Linked-Device braucht trotzdem kein Extra-Container, nur ein zusätzliches Account-Verzeichnis im selben Container | — |
| Reifegrad/Community | Sehr verbreitet, aktiv gepflegt, JSON-RPC + REST beide unterstützt | Weniger fertige Tooling-Schicht |

→ **Ein zentraler `signal-cli-rest-api`-Container** (Modus `json-rpc`, nicht `normal`, wegen
Push-fähigem Event-Stream statt reinem Request/Response) neben ducki-node. Er verwaltet mehrere
Signal-"Accounts" (= Telefonnummern) intern; das Node-Plugin spricht ihn nur über HTTP an,
genau wie der Telegram-Connector `api.telegram.org` anspricht. Passt in `allowedHosts` als
`localhost:<port>` bzw. internes Docker-Netz.

## 3. Zwei Betriebsmodi im selben Plugin

Ein `signal-connector`-Plugin, `plugin.json`-Setting `mode: "shared" | "linked"` pro
Connector-Instanz (mehrere Instanzen möglich, wie bei Discord/Telegram mit mehreren Configs):

### Modus A — Shared Bot-Nummer
- Eine zentrale ducki.cloud-Nummer, registriert einmalig über signal-cli-rest-api
  (`/v1/register` + `/v1/register/{number}/verify/{code}`)
- Alle Tenants schreiben dieselbe Nummer an; Routing zum richtigen Tenant über
  `allowedUserId`-artige Zuordnung (analog Telegram) oder über eine Tenant-Präfix-Konvention
  im ersten Nachrichtentext (Onboarding-Flow, vom Laravel-Backend generiert)
- Einfachster Start, kein Link-Flow nötig

### Modus B — Linked Device pro Tenant
- Agent linkt sich per QR-Code als Zweitgerät an den echten Signal-Account eines Users
  (`/v1/qrcodelink` liefert QR/URI, User scannt in seiner Signal-App unter
  "Verknüpfte Geräte")
- Danach kann der Agent im Namen des Users senden/empfangen — echter Zugriff auf dessen
  reale Kontakte/Gruppen
- Pro Tenant ein eigener Account-Slot im selben Container + eigenes Session-Datenverzeichnis
  (persistent, sensibel — siehe Abschnitt 6)
- Link-Flow (QR anzeigen, Verknüpfung bestätigen, Re-Link bei Geräte-Verlust) muss als
  UI-Schritt im Laravel-Backend oder in der Plugin-`settingsPage` abgebildet werden

Beide Modi liefern eingehende Nachrichten über denselben `ctx.onInboundMessage`-Pfad, nur
`portal: "signal"` mit unterschiedlichem `externalConversationId`-Namespace
(z.B. `shared:<phone>` vs. `linked:<tenantId>:<phone>`), damit spätere Auswertung/Routing
eindeutig bleibt.

## 4. Plugin-Struktur (folgt dem bestehenden Connector-Vertrag)

Spiegelt [telegram-connector](../apps/server/plugins/telegram-connector/connector.js) 1:1:

```
apps/server/plugins/signal-connector/
  plugin.json          # provides.connector, settings: mode, apiBaseUrl, phoneNumber, tenantId...
  connector.js          # createConnector(manifest): connect/disconnect/send/getStatus
  poller.js             # statt Long-Poll: JSON-RPC Event-Subscription (Server-Sent oder WS,
                         # je nach signal-cli-rest-api Version) auf eingehende Nachrichten
  send.js                # sendSignalMessage(apiBaseUrl, account, target, text, attachments)
  settingsPage/          # Modus-Auswahl, QR-Anzeige für Linked-Device, Registrierungs-Flow
  skills/signal/SKILL.md
```

`connector.js` Kernlogik:
- `connect()`: prüft `mode`; bei `shared` verbindet es sich mit dem bereits registrierten Account;
  bei `linked` prüft es, ob bereits verknüpft ist (sonst `status.configured = false` +
  Hinweis "QR-Link ausstehen", analog zum "Missing Telegram bot token"-Pfad)
- Event-Handler ruft `ctx.onInboundMessage({ portal: "signal", externalConversationId, sourceMessageId, authorId, userName, content, attachments })` — identisches Shape wie Discord/Telegram, damit der bestehende Gateway-Field-Aliasing-Fix aus [[gateway-discord-field-aliasing]] direkt mitgilt
- `send(target, message)`: POST an `/v2/send` von signal-cli-rest-api

## 5. User→User: Vermittlung, kein Relay

Wie entschieden: Ducki initiiert nur den Kontakt, mischt sich danach nicht mehr ein.
Konkret als **Skill/Tool**, kein neuer Connector-Mechanismus:

- Neues Agent-Tool `signal.introduce(userA, userB, context)`:
  1. Prüft Opt-in beider Seiten (z.B. über Laravel-Backend-Flag, nicht automatisch)
  2. Sendet an User A eine Nachricht mit User Bs Signal-Nummer/Gruppenlink (und optionalem
     Kontext-Text vom Agent) und umgekehrt — oder erstellt eine **Signal-Gruppe** mit beiden
     (`/v1/groups`) und dem Bot als drittem Mitglied, den der Bot danach sofort wieder verlässt
     (`/v1/groups/{id}/quit`), sodass nur die Einladung automatisiert war
  3. Kein Message-Relay-Code nötig — spart genau die Komplexität (Konsens-Handling,
     Store-and-Forward, Missbrauchspotential eines unsichtbaren Vermittlers), die beim
     "Ducki relayt aktiv"-Modell nötig gewesen wäre

Das hält den Scope klein und vermeidet, dass Ducki dauerhaft "in der Mitte" von zwei
Privatgesprächen sitzt (Datenschutz-Fußabdruck bleibt minimal: nur der Einladungsmoment,
keine laufende Nachrichtenspeicherung).

## 6. Betrieb, Sicherheit, Compliance

- **Session-State ist hochsensibel**: Das signal-cli-Datenverzeichnis enthält die
  Identitätsschlüssel des Accounts (bei Linked-Device: Zugriff auf den *echten* Account des
  Users). Muss verschlüsselt at rest liegen, pro Tenant isoliert, Backup-Strategie definieren
  — Kompromittierung = vollständige Übernahme des Signal-Zugriffs.
- **Rate-Limits/Spam-Erkennung**: Signal sperrt Nummern bei auffälligem automatisiertem
  Massenversand ohne Vorwarnung. Modus A (Shared-Nummer, viele Tenants) ist hier das
  höhere Risiko — Throttling und Monitoring auf Connector-Ebene einbauen (Warn-Schwelle,
  bevor Signal reagiert).
- **Kein Business-Verification-Badge**: anders als WhatsApp Business sieht der Empfänger
  nur eine normale Nummer. Erste Nachricht sollte sich immer klar als Ducki/Bot zu erkennen
  geben (Transparenzpflicht, auch DSGVO-relevant bei automatisierter Kommunikation).
- **Laravel-Backend-Rolle** (ducki.cloud): Tenant-Verwaltung, Registrierungs-/Verifizierungs-Flow
  für Modus A, QR-Link-UI + Re-Link-Handling für Modus B, Opt-in-Flags für User→User-Vermittlung,
  Billing/Nummern-Kontingent. Kein eigener Signal-Code im Laravel-Teil nötig — der spricht nur
  die ducki-node-Plugin-API an (Settings/Secrets-Store, existiert schon laut
  [[plugin-phase1-context-secrets]]).

## 7. Phasenplan

1. **Infra**: `signal-cli-rest-api`-Container aufsetzen (json-rpc-Modus), eine Test-Nummer
   registrieren, manuell senden/empfangen verifizieren
2. **Plugin-Grundgerüst Modus A**: `signal-connector` nach Telegram-Vorbild, nur Shared-Bot,
   Send + Receive, ins bestehende Portal-Routing einhängen
3. **Settings/Registrierungs-UI**: SMS-Verifizierungs-Flow in `settingsPage`
4. **Modus B (Linked Device)**: QR-Link-Flow, Account-Isolation pro Tenant, Re-Link-Handling
5. **`signal.introduce`-Tool** für User→User-Vermittlung
6. **Hardening**: Rate-Limit-Schutz, Verschlüsselung des Datenverzeichnisses, Monitoring/Alerts
   bei Sperr-Anzeichen

Jede Phase ist einzeln testbar und schaltet unabhängig scharf — Modus A liefert bereits
den vollen Agent↔User-Flow, bevor Modus B oder die Vermittlung angegangen werden.
