# Eigenes Messaging-System (Alternative zu Signal)

Ziel: eigenständiges Messaging — Agent↔User und User↔User —, authentifiziert über den
bestehenden Laravel-API-Key (ducki.cloud), ohne Abhängigkeit von Signals Netzwerk/Nummern-Zwang.
E2E-Verschlüsselung und Multi-Device-Sync werden gefordert, "wenn möglich" — dieser Plan zeigt,
was das jeweils kostet, und empfiehlt einen konkreten Weg.

## 1. Warum das schwerer ist, als es klingt

Ein Chat-System zu bauen ist einfach. Ein Chat-System mit **echtem** E2E (Server sieht nie
Klartext) *und* **Multi-Device** (Nachricht landet korrekt verschlüsselt auf allen Geräten eines
Users, auch neu hinzugekommenen) ist eines der am meisten unterschätzten Probleme in der
Kryptografie-Praxis — genau der Teil, an dem Signal selbst am längsten gearbeitet hat
(Sesame-Algorithmus für Multi-Device kam Jahre nach dem ursprünglichen Double-Ratchet-Protokoll).
Die Kernschwierigkeit: jedes Gerät hat einen eigenen Schlüssel, jede Nachricht muss pro
Empfänger-*gerät* neu verschlüsselt werden, neue Geräte müssen nachträglich Zugriff auf
(zumindest neue) Konversationen bekommen, verlorene Geräte müssen sicher widerrufen werden —
und ein einziger Fehler in dieser Logik untergräbt die gesamte Verschlüsselung.

Daraus folgt die wichtigste Entscheidung dieses Plans: **nicht den Krypto-Kern selbst entwerfen**,
sondern eine bereits gehärtete, quelloffene Implementierung als Bibliothek/Protokoll einsetzen —
eigene Infrastruktur, fremde (geprüfte) Kryptografie.

## 2. Drei realistische Wege — Empfehlung: Weg B

| | A: Pragmatisches E2E (libsodium, kein Ratchet) | **B: Matrix-Protokoll self-hosted (Olm/Megolm)** | C: Double Ratchet komplett selbst bauen (libsignal als Lib) |
|---|---|---|---|
| Was es ist | Public-Key-Verschlüsselung pro Empfänger-Gerät (`crypto_box`/`sealed_box`), kein Session-Ratchet | Fertiges, offenes Protokoll (Olm=1:1, Megolm=Gruppen), Referenz-Implementierung `matrix-js-sdk` inkl. Multi-Device (Cross-Signing, Device-Verifikation, Key-Backup) bereits fertig | libsignal-Protocol-Bibliothek nutzen, aber Multi-Device-Sync (Sesame-Äquivalent) selbst entwerfen |
| Forward Secrecy / Post-Compromise Security | Nein (statischer Schlüssel pro Gerät) | Ja (Double-Ratchet-basiert) | Ja |
| Multi-Device | Selbst gebaut, aber einfach: pro Gerät ein Schlüsselpaar, Fan-out beim Senden | **Schon gelöst**, produktionsreif, Millionen Nutzer im Einsatz (Element/Matrix) | Selbst gebaut — der schwerste Teil überhaupt |
| Eigene Infrastruktur | Nur Laravel (Key-Directory + Store-and-Forward) | Zusätzlich ein Homeserver (Synapse oder leichter: **Dendrite**/Conduit), Laravel bleibt Identity-Provider davor | Nur Laravel, aber riesiger Custom-Code-Anteil |
| Aufwand | Wochen | Wochen (Integration, nicht Krypto-Entwicklung) | Monate, hohes Sicherheitsrisiko |
| Kontrolle über UX/Branding | Voll | Voll (Homeserver ist eine Blackbox im Hintergrund, Clients sind eure eigenen) | Voll |

**Empfehlung: Weg B.** Ihr bekommt echtes, geprüftes E2E + Multi-Device, ohne die
gefährlichste Kryptografie-Arbeit selbst zu machen — der Homeserver läuft komplett bei euch
(kein Föderations-Zwang, `federation_domain_whitelist: []`), nach außen sieht niemand "Matrix",
Clients sind vollständig eure eigenen (Node-Agent + Web/Mobile über `matrix-js-sdk`).
Weg A bleibt die schnellere Fallback-Option, falls ein eigener Homeserver-Betrieb (Postgres,
Synapse/Dendrite-Prozess) nicht gewünscht ist und man auf Forward Secrecy verzichten kann.
Weg C würde ich nur verfolgen, wenn es einen sehr konkreten Grund gibt, warum Matrix als
Unterbau nicht passt.

## 3. Architektur (Weg B)

```
                     ┌─────────────────────────┐
                     │   Laravel / ducki.cloud   │
                     │  - Identity/API-Key-Auth  │
                     │  - Tenant-/User-Verwaltung│
                     │  - Matrix Application     │
                     │    Service (Auth-Bridge)  │
                     └───────────┬──────────────┘
                                 │ AS-Token (server-seitig, kein User sieht ihn)
                     ┌───────────▼──────────────┐
                     │  Matrix-Homeserver         │
                     │  (Dendrite oder Synapse)   │
                     │  - Speichert nur Chiffrat   │
                     │  - Olm/Megolm-Metadaten     │
                     │  - Device-Registry          │
                     └───────┬───────────┬────────┘
                             │           │
                 ┌───────────▼──┐   ┌────▼──────────┐
                 │ ducki-node    │   │ Web/Mobile     │
                 │ signal-... äh │   │ User-Client    │
                 │ "own-connector"│  │ (matrix-js-sdk  │
                 │ (matrix-js-sdk)│  │  oder React     │
                 │ = Agent-Gerät  │  │  Native SDK)    │
                 └───────────────┘   └────────────────┘
```

- **Auth bleibt bei Laravel**: euer bestehender API-Key/Sanctum-Token authentifiziert den User
  gegen Laravel; Laravel spricht als **Application Service** (privilegierter Server-zu-Server-Akteur,
  offizielles Matrix-Konzept für genau diesen Zweck) mit dem Homeserver und stellt dem
  Client dafür ein kurzlebiges Matrix-Access-Token aus. User/Agent sehen also nach außen nur
  euren API-Key — Matrix ist eine Implementierungsdetail-Ebene dahinter, kein zweites
  Login-System.
- **Homeserver speichert ausschließlich Chiffrat** (bei Räumen mit aktiviertem Megolm) plus
  Routing-Metadaten (wer ist Mitglied, welches Gerät braucht welchen Schlüssel) — Inhalte sind
  für euch selbst nicht einsehbar, das ist der Kern von "echtem E2E".
- **Agent als Client, nicht als Server**: der Ducki-Agent ist selbst ein Matrix-Gerät mit
  eigenen Olm-Keys — er entschlüsselt Nachrichten lokal in ducki-node, genau wie ein Nutzer-Client.
  Das ist auch der einzig korrekte Weg, wenn der Agent inhaltlich antworten soll: der
  Homeserver kann ihm nicht "im Klartext zuspielen", ohne E2E zu brechen.

## 4. Multi-Device von Grund auf gelöst

Matrix bringt das mit, was man sonst selbst bauen müsste:
- **Device-Registrierung**: jedes neue Gerät (Handy, Desktop, ducki-node selbst) erzeugt eigene
  Identity-/One-Time-Keys, meldet sie beim Homeserver an
- **Cross-Signing**: ein User signiert seine eigenen Geräte gegenseitig, sodass andere Teilnehmer
  "diesem Account vertrauen" können, ohne jedes Gerät einzeln zu verifizieren
- **Key-Backup**: verschlüsseltes Backup der Session-Keys (serverseitig gespeichert, aber selbst
  mit einem vom User gehaltenen Recovery-Key verschlüsselt) — neues Gerät kann Verlauf
  entschlüsseln, Server trotzdem blind
- **Geräte-Widerruf**: verlorenes Gerät wird aus der Cross-Signing-Kette entfernt, zukünftige
  Nachrichten werden ihm nicht mehr zugestellt

Das ist exakt die Funktionalität, die in Weg A oder C komplett selbst entworfen werden müsste.

## 5. Datenmodell auf Laravel-Seite

Laravel muss **keine** Krypto-Daten halten (die liegen im Homeserver + client-seitig), sondern:

- `matrix_identities` — Mapping `user_id (Laravel) ↔ matrix_user_id`, Application-Service-seitig
  provisioniert bei Erstkontakt
- `agent_matrix_identity` — analog für den Ducki-Agent (pro Tenant ein eigener Matrix-User, damit
  Konversationen sauber pro Tenant isoliert sind — passt zu "Shared-Tenant per-User-Dirs" aus
  [[saas-cloud-agent-project]])
- `conversation_intents` — für User→User-Vermittlung (siehe Abschnitt 7): welcher Room wurde
  wem vom Agenten vorgeschlagen, Opt-in-Status

## 6. ducki-node-Integration

Neues Plugin `own-connector` (Arbeitsname), strukturell wieder wie
[telegram-connector](../apps/server/plugins/telegram-connector/connector.js), aber ohne
HTTP-Poll-Loop — stattdessen `matrix-js-sdk`-Client mit `startClient()` und dessen
`Room.timeline`-Events:

- `connect()`: loggt sich mit dem vom Laravel-AS ausgestellten Access-Token ein, `client.startClient()`
- Eingehendes, bereits vom SDK entschlüsseltes Event → `ctx.onInboundMessage({ portal: "own", externalConversationId: roomId, authorId, content, attachments })` — identisches Shape wie bei den bestehenden Connectors
- `send(target, message)`: `client.sendMessage(roomId, { body: message.text, msgtype: "m.text" })`,
  SDK übernimmt Megolm-Verschlüsselung transparent
- Device-Key-Material (Olm-Account) liegt lokal im Plugin-Datenverzeichnis, verschlüsselt
  (gleiche Anforderung wie beim signal-cli-Datenverzeichnis im Signal-Plan)

## 7. User→User: gleiche Philosophie wie beim Signal-Plan

Auch hier: **Vermittlung statt Relay**. Der Agent erstellt (via Application-Service-Rechten)
einen Matrix-Room mit beiden Usern, lädt beide ein, verlässt den Room selbst wieder (oder bleibt
optional als stummes Mitglied draußen vor der Tür — Empfehlung: raus, aus denselben
Datenschutz-Gründen wie im Signal-Plan). Die eigentliche Konversation läuft danach nativ
zwischen den beiden User-Clients, vollständig E2E, ohne dass der Agent oder Laravel je
mitliest.

## 8. Phasenplan

1. **Homeserver-Grundbetrieb**: Dendrite (leichtgewichtiger, Go, weniger Betriebsaufwand als
   Synapse) self-hosted, Postgres-Backend, `federation_domain_whitelist: []` (rein intern)
2. **Application-Service-Bridge in Laravel**: AS-Registrierung beim Homeserver, Endpoint der
   aus einem gültigen ducki.cloud-API-Key ein kurzlebiges Matrix-Access-Token für den
   passenden Matrix-User ausstellt
3. **ducki-node `own-connector`**: Agent als eigenes Matrix-Device, Send/Receive über
   `matrix-js-sdk`, ins bestehende Portal-Routing eingehängt (identisch zum Discord/Telegram-Muster)
4. **Web/Mobile-User-Client**: minimaler Chat-Client mit `matrix-js-sdk` (Web) bzw.
   nativem SDK (Mobile), Login über denselben API-Key-Flow
5. **Multi-Device-UX**: Geräte-Liste, Cross-Signing-Verifikation, Key-Backup/Recovery-Key-UI
6. **User→User-Vermittlung**: Agent-Tool zum Erstellen+Einladen+Verlassen eines Rooms
7. **Hardening**: Rate-Limits auf AS-Ebene, Monitoring des Homeservers, Backup-Strategie für
   Postgres + Recovery-Keys

Phase 1–3 liefern bereits den vollen, echten E2E Agent↔User-Flow mit funktionierendem
Multi-Device (sobald ein zweites Gerät sich beim selben Matrix-User anmeldet) — Web/Mobile-Client
und User→User sind unabhängig davon nachrüstbar.

## 9. Vergleich zum Signal-Plan

Beide Docs ([signal-connector-plan.md](signal-connector-plan.md) für Signal,
dieses Dokument für die eigene Lösung) verfolgen bewusst dasselbe Grundmuster
(Connector-Plugin nach bestehendem Vertrag, "Vermittlung statt Relay" bei User→User) — der
Unterschied liegt ausschließlich im Transport/Krypto-Unterbau:

- **Signal**: User müssen Signal bereits installiert haben, kein eigener Infra-Betrieb für den
  Krypto-Teil, aber kein Business-Branding, Rate-Limit-/Sperr-Risiko durch Signal selbst
- **Eigenes System (Matrix-basiert)**: volle Kontrolle, eigenes Branding, kein
  Fremdanbieter-Risiko, aber eigener Homeserver-Betrieb (Phase 1) als zusätzliche Infrastruktur

Beide sind unabhängig voneinander umsetzbar; nichts an diesem Plan setzt den Signal-Plan voraus
oder schließt ihn aus.
