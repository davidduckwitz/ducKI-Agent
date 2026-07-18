---
name: discord
description: "Reliable Discord send flow using gateway configs, diagnostics, and recovery steps"
version: 1.1.0
---

# Discord

## Zweck
Zuverlaessig an Discord senden, ohne URL-Raterei oder unsichere Annahmen.
Nutze immer die vorhandene Gateway-Konfiguration und reagiere auf Diagnosen strukturiert.

## Wann nutzen
- Der Nutzer will eine Nachricht an Discord senden.
- Eine Anfrage nennt "Discord", "Gateway", "Channel", "senden" oder "reply".
- Outbound-Nachrichten aus UI-Chat sollen in einem Discord-Kanal landen.

## Ablauf
1. Nachricht und Zielkandidaten extrahieren.
2. Zwingend zuerst `gateway` mit `action=list_configs` ausfuehren.
3. Discord-Config auswaehlen:
	 - `portal=discord`
	 - `enabled=true`
	 - bevorzugt `outboundReady=true`
4. Ziel bestimmen:
	 - zuerst `externalConversationId` oder `channelId` aus Nutzertext
	 - sonst `defaultTarget` aus Config
5. Mit `gateway action=send` senden.
6. Ergebnis pruefen und bei Fehlern diagnosebasiert recovern.

## Harte Regeln
- Nie zuerst nach `http://localhost...` oder frei erfundenen Endpoints fragen.
- Nie direkt HTTP an Discord bauen, wenn `gateway` Tool verfuegbar ist.
- Vor jedem Send-Versuch zuerst `list_configs` im selben Lauf.
- Bei Konflikt zwischen mehreren Discord-Configs bevorzugt explizite Nutzerangaben (`configId`, Ziel-ID).

## Woher kommen Channel und Token

Quelle der Konfiguration:
- Primar aus Setting `MESSAGING_GATEWAYS` (gespeichert ueber Gateway-UI/API).
- Laden ueber `gateway` Tool mit `action=list_configs`.

Wichtige Felder pro Gateway-Config:
- `id`: eindeutige Config-ID
- `portal`: fuer Discord immer `discord`
- `enabled`: nur aktivierte Configs verwenden
- `defaultTarget`: entspricht dem konfigurierten `channelHint` (Default Channel-ID)
- `outboundReady`: zeigt, ob Outbound-Transport verfuegbar ist

Token- und Transport-Aufloesung (Discord):
1. Bot-Token aus Env `DISCORD_BOT_TOKEN` (hoechste Prioritaet)
2. Sonst Config `authToken` (als Bot-Token)
3. Sonst Config `webhookSecret`, falls URL (Webhook-Transport)
4. Wenn nichts davon vorhanden ist: Diagnose `discord_transport_not_configured`

Ziel-Channel-Aufloesung:
1. `externalConversationId` aus Tool-Input
2. Alias `channelId` aus Tool-Input
3. Sonst `defaultTarget` aus `list_configs`
4. Wenn leer: Diagnose `missing_target`

Wie laden (Pflichtablauf):
1. `gateway {"action":"list_configs"}`
2. Discord-Config mit `enabled=true` und bevorzugt `outboundReady=true` waehlen
3. Ziel bestimmen (Input zuerst, dann `defaultTarget`)
4. `gateway {"action":"send", ...}` ausfuehren
5. Bei Fehlern `data.diagnostic.code` auswerten und gezielt recovern

## Tool Patterns

### 1) Verfuegbare Configs laden

```json
{"action":"list_configs"}
```

Erwartung:
- Rueckgabe enthaelt `id`, `portal`, `enabled`, `defaultTarget`, `outboundReady`.

### 2) Nachricht senden (Discord)

```json
{
	"action": "send",
	"portal": "discord",
	"configId": "<config-id>",
	"externalConversationId": "<channel-id>",
	"message": "<text>"
}
```

Alternative wenn Channel direkt genannt ist:

```json
{
	"action": "send",
	"portal": "discord",
	"channelId": "<channel-id>",
	"message": "<text>"
}
```

## Diagnose und Recovery

Wenn `gateway` fehlschlaegt, nutze `error` plus `data.diagnostic.code`:

- `config_not_found`
	- Sofort `list_configs` erneut ausfuehren und passende Discord-Config waehlen.
- `missing_target`
	- `externalConversationId/channelId` aus Anfrage nutzen, sonst `defaultTarget`.
	- Nur wenn beides fehlt, gezielt nach Channel-ID fragen.
- `discord_transport_not_configured`
	- Melde klar: Bot-Token oder Discord-Webhook fehlt.
- `discord_http_error` oder `discord_webhook_http_error`
	- HTTP-Status nennen und einmal mit alternativer Discord-Config erneut versuchen.
- `missing_message`
	- Nachricht neu formulieren lassen oder aus Kontext rekonstruieren.

## Antwortformat
- Bei Erfolg kurz bestaetigen: gesendet, welche Config, welches Ziel.
- Bei Fehlern konkret sagen was fehlt und naechsten klaren Schritt nennen.
- Keine pauschalen Fragen nach URLs, wenn Diagnosedaten bereits konkrete Ursache liefern.

## Guardrails
- Nicht direkt nach einer hypothetischen localhost-URL fragen, wenn Gateway-Config vorhanden sein kann.
- Bei Sendefehlern zuerst `list_configs` erneut ausfuehren und Outbound-Bereitschaft pruefen.
- Fehler immer mit Ursache und Diagnose-Code zurueckgeben.
- Keine Endlosschleifen: maximal ein Retry mit anderer passender Config.
