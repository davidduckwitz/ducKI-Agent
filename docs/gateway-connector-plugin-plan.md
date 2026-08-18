# Gateway → Connector-Plugin — Design- & Implementierungsplan

> Ziel: Discord-spezifischen Code aus dem Core lösen und als erstes von mehreren
> **Connector-Plugins** abbilden, sodass neue Messaging-Plattformen (Telegram, Slack,
> Signal, Matrix, ...) ohne Core-Änderung hinzugefügt werden können — analog zum
> bestehenden `plugins/`-System (Tools/Skills/Settings), erweitert um eine neue
> Fähigkeit: **langlebige Hintergrund-Verbindungen** (WebSocket/Polling-Connector).

Status: **Design abgeschlossen, Implementierung ausstehend.**

Vorbild-Analyse: [NousResearch/hermes-agent `gateway/`](https://github.com/NousResearch/hermes-agent/tree/main/gateway), speziell `gateway/platforms/base.py` + `gateway/platforms/ADDING_A_PLATFORM.md` (siehe Abschnitt 2).

---

## 1. Ausgangslage — wie Discord/Gateway heute verdrahtet ist

Discord ist **nicht an einer Stelle** implementiert, sondern über 5 Orte verteilt, teils dupliziert:

| # | Ort | Rolle |
|---|---|---|
| a | [`apps/server/src/lib/discord-gateway-ws.ts`](../apps/server/src/lib/discord-gateway-ws.ts) | Discord-Gateway-v10-WS-Client (`ws`-Paket), sauber gekapselt: `{botToken, guildId?, allowedUserId?, onMessage, onReady?, onError?}` |
| b | [`apps/server/src/index.ts`](../apps/server/src/index.ts) (Z. 192–225, 488–588, 842, 848–850) | Hardcoded Boot-Wiring: liest `DISCORD_*`-Env bzw. `MESSAGING_GATEWAYS`-Setting, instanziiert den WS-Client **unconditional beim Serverstart**, inbound → HTTP-Self-POST an `/api/gateway/inbound` |
| c | [`apps/server/src/routes/gateway.ts`](../apps/server/src/routes/gateway.ts) (1838 Zeilen) | HTTP-Surface `/api/gateway`: Config-CRUD (`MESSAGING_GATEWAYS`-Setting, **unverschlüsselt**), `/inbound`, Discord-Webhook (Ed25519-Signaturprüfung), Discord-spezifische Sende-/Reaction-/Chunking-Helper |
| d | [`packages/agent/src/workflow/workflow-tools.ts`](../packages/agent/src/workflow/workflow-tools.ts) (~130–1220) | **Zweite, unabhängige** Discord-Send-Implementierung als Agent-Tool `gateway` (`list_configs`/`send`), mit eigenen Limits, leicht von (c) abgedriftet |
| e | [`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts) (1434–1466, 1810–1820, 3134–3149) + [`tool-aliases.ts`](../packages/agent/src/tools/tool-aliases.ts) (74–76, 368–379) + [`reserved-tool-names.ts`](../packages/agent/src/tools/reserved-tool-names.ts:14) | Discord-spezifisches Feld-Aliasing, Validierung, Error-Hints **hardcoded im Core-Agent-Loop** |

UI: [`apps/web/src/components/gateway/MessagingGateway.tsx`](../apps/web/src/components/gateway/MessagingGateway.tsx) ist strukturell bereits generisch (ein Formular, freier `portal`-Text), aber die **Feld-Labels sind Discord-conditional** (`guildId`, `appId`, `publicKey` ergeben nur für Discord Sinn). [`SetupWizardModal.tsx`](../apps/web/src/components/setup/SetupWizardModal.tsx) ist eine **dritte** Stelle mit eigenem Discord-Onboarding.

Config/Secrets: `DISCORD_BOT_TOKEN` u.a. als Env **oder** `MESSAGING_GATEWAYS`-DB-Setting — ein plain JSON-Blob, **unverschlüsselt**, obwohl das Plugin-System bereits einen verschlüsselten Per-Plugin-Settings-Store kennt (`type:"secret"`).

**Kernproblem für die Modularisierung:** Das bestehende Plugin-System ([`plugin-manifest.ts`](../packages/agent/src/plugins/plugin-manifest.ts), [`plugin-registry.ts`](../packages/agent/src/plugins/plugin-registry.ts), Referenz: `apps/server/plugins/github-connector/`) kennt nur **request-scoped** Fähigkeiten (`moduleTools.execute(input, ctx)` pro Tool-Aufruf, statische UI-Seiten). Es gibt **keine Lifecycle-Hook für einen langlebigen Hintergrundprozess** (persistente WS-Verbindung), die beim Serverstart hochfährt und beim Shutdown sauber schließt. Das ist die zentrale Lücke, die dieser Plan schließt.

---

## 2. Vorbild: hermes-agent

Hermes trennt explizit zwei Wege, empfiehlt den Plugin-Weg:

- **Plugin-Path** (empfohlen): Verzeichnis mit `plugin.yaml` + `adapter.py`, Klasse erbt von `BasePlatformAdapter`, registriert sich über einen `register(ctx)`-Entry-Point (`ctx.register_platform()`). **Null Core-Änderungen.**
- **Built-in-Path**: 16 Schritte über viele Core-Dateien verteilt (Adapter, Enum, Factory, Auth-Maps, Session-Source, Prompt-Hints, Toolset, Cron, ...) — das ist strukturell **exakt der heutige Zustand unseres Discord-Codes** (Punkt 1a–e oben). Hermes nennt das explizit die **nicht** empfohlene Variante.

`BasePlatformAdapter` verlangt: `connect()`, `disconnect()`, `send()`, `send_typing()`, `send_image()`, `get_chat_info()` (+ optionale Stubs für Dokumente/Voice/Video), Reconnect mit Backoff+Jitter, ein `check_<platform>_requirements()`, und nutzt `self.handle_message(event)` für den Inbound-Dispatch in eine gemeinsame Session-Pipeline. Der `PlatformRegistry` lädt Adapter **lazy** (Factory statt direktem Import), damit ungenutzte SDKs den Boot nicht verlangsamen.

**Übertragbares Prinzip:** ein schlankes, dukt­getyptes Interface (`connect/disconnect/send`) + eine Registry mit Lifecycle-Hooks + Konfiguration/Secrets pro Plugin, keine Core-Änderung pro neuer Plattform.

---

## 3. Architekturentscheidung

| Frage | Entscheidung | Begründung |
|---|---|---|
| Eigener „Connector"-Bereich vs. Erweiterung des Plugin-Systems? | **Erweiterung des bestehenden Plugin-Systems** um eine neue Fähigkeit `provides.connector` | Zwei parallele Erweiterungsmechanismen (Plugins *und* Connectoren) wären selbst die Art von Duplizierung, die wir beseitigen wollen. Settings/Secrets/Trust/UI-Pages/Hot-Reload existieren für Plugins bereits fertig. |
| UI: eigener Gateway-Bereich bleibt bestehen? | **Ja, aber generisch** — `MessagingGateway.tsx` wird zur Konnektor-Übersicht (Liste + Status je Connector-Plugin), Detail-Konfiguration läuft über die **existierende Plugin-`settingsPage`-Iframe-Mechanik** (wie `PluginsPage.tsx` es für andere Plugins schon tut) | Vermeidet ein drittes Konfig-Formular; Discord-spezifische Felder (`guildId`, `appId`, `publicKey`) wandern ins Discord-Plugin, das UI-Formular bleibt generisch |
| Agent-Tool-Name `gateway` ändern? | **Nein, `gateway` bleibt der stabile Tool-Name im Core** | `gateway` ist reserved, hat Aliasing/Validierung/Error-Hints im Core-Agent-Loop, taucht in Skills/Doku auf. Umbenennen bricht bestehende Konversationen/Skills ohne Mehrwert. Der Tool-*Name* bleibt, die *Implementierung* dahinter wird generisch (delegiert an die Connector-Registry statt Discord-Sonderlogik) |
| Secrets-Speicherung | **Migration von `MESSAGING_GATEWAYS` (plain JSON) zu Plugin-Settings (`type:"secret"`, verschlüsselt)** pro Connector-Plugin | Sicherheitsverbesserung, nutzt vorhandene Infrastruktur ([`plugin-phase1-context-secrets`](plugin-phase1-context-secrets.md)) |
| Bestehende `DISCORD_*`-Envs | **Weiterhin unterstützt als Fallback/Seed** beim ersten Plugin-Boot, dann in den verschlüsselten Store migriert | Kein Breaking Change für bestehende Deployments |

---

## 4. Neue Plugin-Fähigkeit: `provides.connector`

Erweiterung von `PluginManifestSchema` ([`plugin-manifest.ts`](../packages/agent/src/plugins/plugin-manifest.ts)) um ein optionales Feld, analog zu `moduleTools` (verlangt `trust:"node"`, da echte Netzwerk-/Socket-Zugriffe nötig sind):

```ts
provides: {
  // ... bestehende Felder ...
  connector?: {
    module: string;          // z.B. "connector.js", ESM-Modul im Plugin-Verzeichnis
    portal: string;          // stabiler Bezeichner, z.B. "discord" — ersetzt heutiges MessagingGatewayConfig.portal
  };
}
```

Das Connector-Modul exportiert eine Factory, deren Instanz ein schlankes Interface implementiert (TS-Analogon zu `BasePlatformAdapter`):

```ts
export interface ConnectorAdapter {
  connect(ctx: ConnectorContext): Promise<void>;
  disconnect(): Promise<void>;
  send(target: ConnectorTarget, message: OutboundMessage): Promise<void>;
  getStatus(): ConnectorStatus; // {configured, active, connectedAt?, lastError?} — Ersatz für DiscordGatewayRuntimeStatus
}

export interface ConnectorContext extends PluginToolContext {  // wiederverwendet settings/secrets/fetch/logger
  onInboundMessage(msg: InboundMessage): Promise<void>;        // ruft die bestehende Agent-Run-Pipeline
}
```

`InboundMessage`/`OutboundMessage`/`ConnectorTarget` sind generische, plattformneutrale Typen (Text, Attachments, Conversation-Referenz) — der heutige `/api/gateway/inbound`-Handler in `routes/gateway.ts` wird auf diese Typen zugeschnitten statt Discord-Felder direkt zu lesen.

---

## 5. Registry & Lifecycle-Integration

Neue Datei `apps/server/src/lib/connector-registry.ts`, analog zu [`plugin-manager.ts`](../apps/server/src/lib/plugin-manager.ts):

- Beim `PluginManager.create()`-Boot (`index.ts:656`): nach dem Laden aller Manifeste werden alle Plugins mit `provides.connector` gefiltert, deren Modul importiert und `connect(ctx)` aufgerufen — **nur wenn** das Plugin enabled ist **und** seine Pflicht-Settings (z.B. Bot-Token) gesetzt sind (`getStatus().configured`).
- Graceful Shutdown (heute `index.ts:848–850` Discord-spezifisch) → generische Schleife über alle aktiven Connectoren, `disconnect()`.
- Hot-Reload: bestehende Debounce-/Idle-Gate-Logik aus `PluginManager.requestReload()` wird wiederverwendet, **aber** Connector-Reconnects müssen zusätzlich vor dem Tool-Hot-Swap laufen (Verbindungsstatus ändert sich nicht bei `runningCount > 0`, nur der Tool-Katalog).
- Status-Aggregation ersetzt `app.locals["discordGatewayStatus"]` durch `app.locals["connectorStatuses"]: Record<portal, ConnectorStatus>`, konsumiert von `routes/agents.ts` (`GET /api/agents/live`) und dem UI-Status-Dot (`Sidebar.tsx`/`LiveAgentsFooter.tsx`).

---

## 6. Discord als erstes Connector-Plugin

Neues Verzeichnis `apps/server/plugins/discord-connector/`:

```
plugin.json        # trust:"node", provides.connector, settings:[botToken(secret), guildId, allowedUserId], allowedHosts:["discord.com","gateway.discord.gg"]
connector.js        # verschiebt discord-gateway-ws.ts hierher (WS-Client bleibt fast unverändert, nur Context-Injection statt Konstruktor-Callbacks)
send.js              # konsolidiert die Sende-/Reaction-/Chunking-Logik aus routes/gateway.ts UND workflow-tools.ts (heute zwei Implementierungen → eine)
webhook.js           # Ed25519-Signaturprüfung + Interaktions-Handling (heute in routes/gateway.ts POST /:portal/:id/webhook)
settingsPage/         # ersetzt die Discord-Sonderfelder aus MessagingGateway.tsx
```

Migrationsschritte:
1. `discord-gateway-ws.ts` → `connector.js`, Konstruktor-Callbacks (`onMessage/onReady/onError`) durch `ConnectorContext` ersetzen.
2. Die **eine** kanonische Discord-Send-Logik (Chunking, Multipart-Attachments, Reactions) aus `routes/gateway.ts` + `workflow-tools.ts` zusammenführen, ins Plugin verschieben; das Core-`gateway`-Tool ([`workflow-tools.ts`](../packages/agent/src/workflow/workflow-tools.ts)) wird zu einem dünnen Dispatcher, der `send(target, message)` an die Connector-Registry über `portal` weiterreicht — für jeden künftigen Connector automatisch nutzbar, ohne Tool-Code-Änderung.
3. `POST /api/gateway/inbound` bleibt als **generische** Core-Route bestehen (Trigger-Punkt für Agent-Runs), verliert aber die Discord-spezifischen Zweige (Voice-STT-Provider-Auswahl kann bleiben, ist plattformneutral).
4. `POST /:portal/:id/webhook` (Signaturprüfung, Slash-Commands) wandert vollständig ins Plugin (`webhook.js`), von der Core-Route nur noch generisch an `connectorRegistry.getWebhookHandler(portal)` durchgereicht.
5. `agent.ts`-Sonderlogik (Feld-Aliasing/Validierung/Error-Hints, Z. 1434–1466/1810–1820/3134–3149): bleibt **portal-neutral im Core** (gilt für das generische `gateway`-Tool, nicht Discord-spezifisch) — hier ist **keine** Änderung nötig, das war nie Discord-spezifisch, nur der *Inhalt* der Hints teilweise.
6. `tool-aliases.ts`/`reserved-tool-names.ts`: unverändert, `gateway` bleibt reserved.

---

## 7. Settings-Migration

- Einmaliger Migrationslauf beim ersten Boot nach Update: `MESSAGING_GATEWAYS`-Setting lesen, pro Eintrag mit `portal === "discord"` einen `discord-connector`-Plugin-Settings-Eintrag anlegen (verschlüsselt über den bestehenden Plugin-Settings-Store), alte Klartext-Werte aus dem Setting entfernen oder als deprecated markieren.
- `SetupWizardModal.tsx`: Discord-Onboarding-Felder (Z. 29–136, 169–183, 324–396) schreiben künftig über `PUT /api/plugins/discord-connector/settings` statt direkt `MESSAGING_GATEWAYS` zu manipulieren.
- Env-Fallback (`DISCORD_BOT_TOKEN` etc.) bleibt als Seed-Quelle erhalten, aber nur noch **im Plugin**, nicht mehr in `index.ts`.

---

## 8. UI-Anpassung

- `MessagingGateway.tsx`: Config-Formular mit Discord-conditional Labels entfernen. Stattdessen: Liste aller Plugins mit `provides.connector` (neuer Endpoint oder Filter auf bestehendem `GET /api/plugins`), pro Zeile Status-Badge (aus `connectorStatuses`) + „Konfigurieren"-Button, der die vorhandene Plugin-`settingsPage`-Iframe öffnet (gleiche Mechanik wie `PluginsPage.tsx`/`PluginFrontendView.tsx`).
- „Simulate Inbound"-Panel bleibt generisch bestehen (nützlich für alle Connectoren), Conversation-Liste/Suche bleibt unverändert (arbeitet bereits auf `portal`-neutralen Conversations).
- `api.gateway.*` in `apps/web/src/lib/api.ts`: `GET/PUT /gateway` (Config) entfällt zugunsten von `api.plugins.*`; `POST /gateway/inbound` bleibt.

### 8b. Setup-Wizard (`SetupWizardModal.tsx`)

Heute: ein fest verdrahteter Discord-Onboarding-Schritt (Z. 29–136, 169–183, 324–396), der direkt `MESSAGING_GATEWAYS` beschreibt. Das ist der Kern-Konflikt mit dem Ziel „mehrere Connectoren ohne Core-Änderung": ein neuer Connector bräuchte sonst wieder eine Wizard-Codeänderung.

**Entscheidung:** Der Wizard bekommt einen generischen „Connectoren"-Schritt statt eines Discord-Spezialschritts:

- Listet alle installierten Plugins mit `provides.connector` (via `GET /api/plugins`, gefiltert), unabhängig davon wie viele es sind.
- Je Connector ein Enable-Toggle + **inline gerenderte** Formularfelder aus dessen `settings[]`-Spec (Typ `text`/`secret`/`number`/`boolean`/`select` — ein generischer Spec→Formular-Renderer, der aus der bestehenden Settings-Typdefinition abgeleitet wird, nicht die iframe-`settingsPage`, damit der Wizard ein durchgehender Formular-Flow ohne Seitenwechsel bleibt). Dieser Renderer ist wiederverwendbar für alle Connector-Plugins und muss nur einmal gebaut werden.
- Nutzer kann **mehrere** Connectoren in einem Durchlauf aktivieren (z.B. Discord *und* Telegram), nicht nur einen.
- Speichern über die vorhandenen Plugin-Endpunkte: `PUT /api/plugins/:name/settings` + `POST /api/plugins/:name/enable`.
- **Verbindungstest vor Abschluss**: neuer, generischer Endpunkt `POST /api/plugins/:name/connector/test`, der `connect()` kurz probiert (Token gültig? erreichbar?) und Klartext-Fehler zurückgibt, bevor der Wizard den Schritt als erledigt markiert — Pendant zu Hermes' `check_<platform>_requirements()`. Verhindert „grün abgehakt, aber Bot verbindet nie" nach dem Wizard.
- Kein Connector-Plugin installiert/aktiviert (Neuinstallation ohne mitgelieferte Connectoren) → Schritt zeigt Hinweis „keine Connectoren verfügbar" statt zu verschwinden, mit Link zur Plugin-Übersicht.

Damit ist der Wizard **so generisch wie die UI-Gateway-Liste selbst** (Abschnitt 8) — dieselbe Datenquelle (`provides.connector`-Plugins + Settings-Specs), zwei Renderorte (Wizard = inline, Übersicht = Karten mit Link zur iframe-`settingsPage` für Detailkonfiguration nach dem Onboarding).

---

## 9. Phasenplan

| Phase | Inhalt | Abhängigkeit |
|---|---|---|
| **0** | Manifest-Schema um `provides.connector` erweitern, `ConnectorAdapter`/`ConnectorContext`-Typen definieren, `ConnectorRegistry` mit Start/Stop-Lifecycle (ohne echtes Plugin — Registry gegen ein Test-Stub-Connector verifizieren) | — |
| **1** | `connector-registry.ts` in `PluginManager`-Boot/Shutdown einhängen, generische `connectorStatuses` in `app.locals`, `routes/agents.ts` umstellen | Phase 0 |
| **2** | Discord-Connector-Plugin bauen: `connector.js` (WS-Client verschieben), Inbound → `ctx.onInboundMessage()` statt HTTP-Self-POST (oder HTTP-Self-POST beibehalten, falls Prozess-Trennung gewünscht ist — **Entscheidung offen, siehe Risiken**) | Phase 1 |
| **3** | Send-Logik konsolidieren: `send.js` im Plugin, `gateway`-Agent-Tool zum Dispatcher umbauen, `workflow-tools.ts`-Duplikat entfernen | Phase 2 |
| **4** | Webhook/Signaturprüfung ins Plugin verschieben, Core-Route generisch durchreichen | Phase 2 |
| **5** | Settings-Migration (`MESSAGING_GATEWAYS` → verschlüsselter Plugin-Store) inkl. einmaligem Migrationsscript, `SetupWizardModal.tsx` umstellen | Phase 3, 4 |
| **6** | UI: `MessagingGateway.tsx` generisch umbauen (Connector-Liste statt Formular) **+** Setup-Wizard-Schritt (8b): generischer Settings-Spec-Renderer, Multi-Connector-Enable, Verbindungstest-Endpoint | Phase 5 |
| **7** | Alte Dateien entfernen: `discord-gateway-ws.ts`, Discord-Zweige in `routes/gateway.ts`/`index.ts` löschen, `skills/discord/SKILL.md` → nach `apps/server/plugins/discord-connector/skills/discord/SKILL.md` verschieben (nicht nur „aktualisieren" — wird Teil des Plugins, s. Abschnitt 10), `tools/gateway/TOOL.md` auf rein portal-neutralen Wortlaut kürzen | Phase 6, alles getestet |

Jede Phase ist unabhängig testbar/deploybar; Discord bleibt während der gesamten Migration funktionsfähig (Parallelbetrieb alt/neu bis Phase 7).

---

## 10. Agent-Zuverlässigkeit: Mappings & Skills müssen pro Connector korrekt sein

Kernanforderung: der Agent darf **nicht** raten, wie er einen Connector adressiert oder was er kann — sonst produziert er falsche Tool-Calls (falsches Zielfeld, zu lange Nachricht, Anhang an Connector ohne Anhang-Support). Das wird strukturell erzwungen, nicht nur dokumentiert:

1. **Skills wandern mit dem Plugin, nicht global.** Heute liegt `skills/discord/SKILL.md` global und beschreibt Discord-Spezifika unabhängig davon, ob Discord überhaupt aktiv ist. Ziel: jedes Connector-Plugin bringt sein SKILL.md **im eigenen Verzeichnis** mit (`apps/server/plugins/discord-connector/skills/discord/SKILL.md`) — das nutzt die bereits vorhandene `provides.skills[]`-Fähigkeit des Plugin-Systems 1:1. Dadurch ist die dem Agenten sichtbare Skill-Doku **automatisch deckungsgleich mit dem tatsächlich aktiven Connector-Zustand**: deaktiviert der Nutzer Discord, verschwindet auch die Discord-Skill-Anleitung — kein Drift zwischen „Doku sagt Discord geht" und „Discord ist eigentlich aus".
2. **Core-Tool-Beschreibung bleibt strikt portal-neutral.** `tools/gateway/TOOL.md` und die Tool-Beschreibung in [`tool-descriptions.ts`](../packages/agent/src/workflow/tool-descriptions.ts) beschreiben nur den generischen Vertrag (`list_configs`/`send`, Ergebnisstruktur). Portal-Spezifika (Zielfeld-Namen, Zeichenlimit, Anhang-Regeln, Beispiel-Payloads) stehen **ausschließlich** in der Plugin-Skill — vermeidet, dass die Core-Tool-Doku bei jedem neuen Connector wieder angefasst werden muss (das war genau das Duplikations-Problem der bisherigen zwei Discord-Doku-Kopien).
3. **`list_configs` liefert strukturierte Capability-Metadata statt nur Config-Liste.** Jede Connector-Antwort in `list_configs` wird um Felder erweitert: `{ maxMessageLength, supportsAttachments, supportsReactions, targetFieldName, exampleTarget }` — aus dem `provides.connector`-Manifest abgeleitet. Das gibt dem Modell **Ground Truth statt Prosa-Gedächtnis** direkt im Tool-Ergebnis, konsistent mit dem bestehenden Prinzip aus [`tool-staging-preview`](tool-staging-preview.md) (kleine Modelle neigen zu Halluzination bei reiner Textbeschreibung — strukturierte Daten im Tool-Result sind robuster als „das steht doch im SKILL.md").
4. **Feld-Aliasing bleibt generisch, Connectoren müssen sich darauf abbilden — nicht umgekehrt.** Die bestehende Alias-Normalisierung in `agent.ts` (`content/text/body→message`, `channel/to/target→channelId`) wird **nicht** pro Connector erweitert (sonst wächst der Core wieder mit jedem neuen Connector). Stattdessen ist es eine verbindliche Anforderung an jedes Connector-Plugin, sein natives Adressierungsschema auf `channelId` (+ optional `threadId`) zu normalisieren — dokumentiert im „Referenz für künftige Connectoren"-Abschnitt (11). Ein Telegram-Connector mit `chatId` muss also intern `channelId → chatId` mappen, nicht der Core `chatId` zusätzlich lernen.
5. **Boot-Validierung der Registry.** Beim Laden eines Connector-Plugins prüft `connector-registry.ts`, ob das deklarierte `targetFieldName` aus Punkt 3 zur bekannten Alias-Menge passt; weicht es ab, wird eine **Boot-Warnung** geloggt („Connector `telegram` deklariert unbekanntes Zielfeld `chat_id` — erwartet `channelId`") statt eines stillen Fehlers zur Laufzeit beim ersten Agenten-Versuch.
6. **Tests pro Connector-Plugin** (Teil von Phase 2/3, keine eigene Phase): ein Mapping-Test (Feld-Aliase → korrektes `send()`-Payload je Connector) sowie ein Skill-Smoke-Test (Beispielprompt „Sende X an Kanal Y über Discord" → erwarteter Tool-Call wird gegen den echten `gateway`-Dispatcher geprüft, nicht nur gegen eine Mock-Beschreibung).

Damit bleibt die Garantie „Agent bedient jeden aktivierten Connector korrekt" **strukturell erzwungen** (Manifest-Pflichtfelder + Boot-Validierung + Tests) statt nur durch sorgfältig gepflegte Doku — Letzteres ist genau das, was beim heutigen `skills/discord/SKILL.md` vs. `tools/gateway/TOOL.md` bereits zu Diskrepanzen geführt hat (near-duplicate content laut Analyse).

---

## 11. Offene Risiken / Entscheidungen

1. **Inbound-Pfad: HTTP-Self-POST vs. direkter Funktionsaufruf.** Heute läuft Inbound über einen HTTP-Loopback-Call (`/api/gateway/inbound`), vermutlich um Prozess-Grenzen offen zu halten (z.B. externer Gateway-Prozess). Ein `trust:"node"`-Plugin läuft **im selben Prozess** — direkter Aufruf von `ctx.onInboundMessage()` wäre einfacher und schneller, ändert aber ggf. bewusst gewählte Entkopplung. → mit Nutzer klären, ob der Loopback-Umweg absichtlich ist (z.B. für künftige Prozess-Isolation).
2. **Mehrere Instanzen desselben Connectors** (zwei Discord-Bots gleichzeitig): heutiges `MessagingGatewayConfig[]` erlaubt mehrere Configs pro Portal. Das neue Modell muss das abbilden — vermutlich: ein Connector-Plugin kann mehrere „Instanzen" aus seinen Settings ableiten (Array-Setting), nicht 1:1 Plugin↔Verbindung.
3. **Hot-Reload einer aktiven WS-Verbindung**: anders als bei reinen Tool-Swaps darf ein Reconnect nicht mitten in einer offenen Discord-Session unnötig triggern — Registry braucht ein Diffing (nur bei geänderten Connector-Settings reconnecten, nicht bei jedem Plugin-Reload).
4. **`storage.sqlite`-Kollision**: Discord-Connector-Plugin braucht ggf. keinen eigenen Storage — Conversations bleiben in der zentralen DB (wie bisher), nur Settings/Secrets werden pluginseitig verschlüsselt gespeichert.
5. **Umfang je nach Zeitbudget**: Phasen 0–4 liefern die eigentliche Modularisierung (neue Connectoren ohne Core-Änderung möglich). Phasen 5–7 (Migration/Cleanup/UI) können zeitlich entkoppelt nachgezogen werden, ohne dass Phase 0–4 wertlos wäre.

---

## 12. Referenz für künftige Connectoren

Nach Abschluss von Phase 0–6 sieht das Hinzufügen von z.B. Telegram so aus:
1. Neues Verzeichnis `apps/server/plugins/telegram-connector/` mit `plugin.json` (`trust:"node"`, `provides.connector`), `connector.js`, `send.js`.
2. Settings deklarieren (`botToken` als `type:"secret"`).
3. **Natives Adressierungsschema auf `channelId`(+`threadId`) normalisieren** (Abschnitt 10, Punkt 4) — z.B. `chatId → channelId` intern mappen.
4. `list_configs`-Capability-Metadata korrekt füllen (`maxMessageLength`, `supportsAttachments`, `supportsReactions`, `targetFieldName`, `exampleTarget`) (Abschnitt 10, Punkt 3).
5. Eigenes `skills/telegram/SKILL.md` im Plugin-Verzeichnis mit Telegram-spezifischen Beispiel-Prompts/Payloads (Abschnitt 10, Punkt 1) — **nicht** die Core-`tools/gateway/TOOL.md` anfassen.
6. Fertig — kein Core-Code ändert sich. Das generische `gateway`-Tool, die UI-Connector-Liste **und der Setup-Wizard** (Abschnitt 8b) erkennen das Plugin automatisch (analog zu Hermes' „Plugin Path", **null Core-Modifikationen**). Die Boot-Validierung (Abschnitt 10, Punkt 5) warnt sofort, falls Schritt 3 vergessen wurde.
