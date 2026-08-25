# Plugin- und Skill-Entwicklung

Dieses Dokument beschreibt das dateibasierte Erweiterungssystem von DucKI vollständig genug, um Plugins und Skills sowohl über den Builder als auch manuell zu entwickeln. Maßgeblich für die Implementierung sind `packages/agent/src/plugins/plugin-manifest.ts`, `packages/agent/src/plugins/plugin-registry.ts` und `packages/agent/src/skill-selector/validate.ts`.

## 1. Grundmodell

Ein Plugin ist ein Ordner unter `plugins/<name>/` beziehungsweise dem durch `DUCKI_PLUGINS_DIR` gesetzten Verzeichnis. Es gibt keinen Plugin-Datensatz in der Hauptdatenbank. `plugin.json` ist die Quelle für Metadaten und bereitgestellte Fähigkeiten. Benutzerseitige Aktivierungsabweichungen werden in `plugins/.state.json` gespeichert.

Ein Skill ist ein Ordner unter dem konfigurierten `SKILLS_PATH` mit einer verpflichtenden `SKILL.md`. Der Agent scannt Skills erneut und verwendet einen mtime-/Größen-Cache, sodass neue oder geänderte Skills ohne Änderung am Agent-Code auffindbar werden.

Namensregeln für Plugin und Skill:

- Kleinbuchstaben, Ziffern und einzelne Bindestriche
- regulärer Ausdruck: `^[a-z0-9]+(-[a-z0-9]+)*$`
- maximal 64 Zeichen
- Name muss dem Ordnernamen entsprechen

## 2. Minimales Plugin

```text
plugins/
└── hello-world/
    └── plugin.json
```

```json
{
  "name": "hello-world",
  "version": "1.0.0",
  "description": "Kleines Beispiel-Plugin",
  "enabled": true,
  "provides": {}
}
```

Optionale Manifest-Metadaten:

| Feld | Typ / Werte | Bedeutung |
|---|---|---|
| `author` | String | Autor |
| `license` | String | Lizenz |
| `compatibility` | String, max. 500 | Kompatibilitätshinweis |
| `icon` | String, max. 16 | Emoji oder kurzes UI-Symbol |
| `category` | `overview`, `workspace`, `automation`, `knowledge`, `system` | Sidebar-Gruppe für Frontends |
| `trust` | `sandboxed` oder `node` | Ausführungsrechte; Standard ist `sandboxed` |
| `allowedHosts` | String-Array | Host-Allowlist für Plugin-Fetch |
| `storage.sqlite` | Boolean | eigene SQLite-Datenbank aktivieren |
| `enabled` | Boolean | Aktivierungsstandard |

`trust: "node"` darf nur für bewusst geprüfte Plugins verwendet werden. Es erlaubt Module und Connectoren mit vollem Node-Kontext. Vom Agenten erzeugte Plugins unterliegen strengeren Regeln als manuell entwickelte Plugins.

## 3. `provides`-Optionen

| Feld | Inhalt |
|---|---|
| `dataSourceTools` | relative Pfade zu deklarativen `*.datasource.json`-Tools |
| `scriptTools` | relative Pfade zu sandboxed Tool-JSON-Dateien |
| `moduleTools` | relative Pfade zu ESM-Modulen; benötigt `trust: "node"` |
| `skills` | relative Ordnerpfade mit jeweils einer `SKILL.md` |
| `toolMappings` | Aliase `{ "alias": "...", "tool": "..." }` |
| `settings` | Plugin-spezifische Einstellungsdefinitionen |
| `oauth` | relative Pfade zu OAuth-Konfigurationen |
| `settingsPage` | reine Einstellungs-UI als HTML-Seite |
| `frontendPage` | vollständige Plugin-Mini-App |
| `widgets` | mehrere unabhängig platzierte Widget-Seiten |
| `widgetPage`, `widgetPlacement` | Legacy-Einzelwidget; für neue Plugins nicht verwenden |
| `overlayPage` | transparente globale Overlay-Seite |
| `pets` | deklarative Pet-Pack-JSON-Datei |
| `connector` | langlebiger Node-Connector `{ module, portal }` |
| `llmProviders` | zusätzliche LLM-Provider für Settings und Modellkatalog |

## 4. Mehrere Widgets

Ein Plugin kann maximal 24 Widgets bereitstellen. Jede ID muss innerhalb des Plugins eindeutig sein.

```json
{
  "name": "weather-widgets",
  "version": "1.0.0",
  "description": "Wetter an mehreren UI-Positionen",
  "provides": {
    "widgets": [
      {
        "id": "weather-top",
        "page": "widgets/weather-top/index.html",
        "placement": "topbar",
        "align": "right",
        "frame": "borderless",
        "background": "transparent",
        "height": 40,
        "width": "md"
      },
      {
        "id": "weather-dashboard",
        "title": "Wetter",
        "page": "widgets/weather-dashboard/index.html",
        "placement": "dashboard",
        "align": "full",
        "frame": "card",
        "background": "card",
        "height": 240,
        "width": "full"
      }
    ]
  }
}
```

### Widget-Felder

| Feld | Erlaubte Werte | Standard / Grenze |
|---|---|---|
| `id` | lowercase-kebab | erforderlich, max. 64 |
| `page` | relativer Dateipfad | erforderlich |
| `placement` | siehe unten | erforderlich |
| `align` | `left`, `center`, `right`, `full` | `full` |
| `frame` | `card`, `borderless` | `card` |
| `background` | `card`, `transparent`, `inherit` | `card` |
| `height` | Ganzzahl in Pixeln | 20–800, Standard 120 |
| `width` | `auto`, `sm`, `md`, `lg`, `full` oder Pixelzahl | Zahl: 40–2000; Standard `full` |
| `title` | String | optional, max. 100 |

Breiten-Tokens: `sm = 12rem`, `md = 20rem`, `lg = 32rem`, `full = 100%`.

### Positionen

- `dashboard`: responsives Kartenraster im Dashboard
- `topbar`: feste Leiste oberhalb des Inhalts
- `footer`: feste Leiste unterhalb des Inhalts
- `sidebar-above-logo`: oberhalb des Logo-/Headerbereichs
- `sidebar-before-mode`: direkt über Standard-/Coding-Umschalter
- `sidebar-after-mode`: direkt unter Standard-/Coding-Umschalter
- `sidebar-content`: im scrollbaren Sidebar-Inhalt

Topbar und Footer gruppieren `left`, `center` und `right` in drei Spalten. `full` erhält eine eigene volle Zeile. In Sidebar-Slots werden Widgets vertikal angeordnet. `align` ist dort deshalb nur eingeschränkt sichtbar.

### Widget-HTML

Widgets laufen in sandboxed iframes. Relative CSS-, Script- und Bildpfade werden relativ zum Verzeichnis der Widget-Seite ausgeliefert. Die öffentliche URL lautet:

```text
GET /api/plugins/<plugin>/ui/widgets/<widget-id>/
GET /api/plugins/<plugin>/ui/widgets/<widget-id>/<asset-path>
```

Der Server verhindert, dass `page` oder Assetpfade den Plugin- beziehungsweise UI-Ordner verlassen. Empfohlenes Grundgerüst:

```html
<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    html, body { margin: 0; height: 100%; background: transparent; color: inherit; }
  </style>
</head>
<body>Widget-Inhalt</body>
</html>
```

Der Host hängt die aufgelöste Theme-Einstellung und Akzentfarbe an jede Widget-URL:

```text
?theme=light|dark&accent=blue|violet|green|orange|rose|zinc
```

Damit folgt ein iframe nicht nur dem Betriebssystem, sondern exakt den Agent-Einstellungen. Bei einem Theme- oder Akzentwechsel ändert der Host die iframe-URL und lädt das Widget mit den neuen Werten neu. Ein Widget sollte die Parameter vor dem Rendern anwenden:

```html
<style>
  :root { color-scheme: light; --text: #111827; --accent: #2563eb; }
  :root[data-theme="dark"] { color-scheme: dark; --text: #f3f4f6; }
  :root[data-accent="violet"] { --accent: #8b5cf6; }
  body { color: var(--text); background: transparent; }
</style>
<script>
  const params = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
  document.documentElement.dataset.accent = params.get("accent") || "blue";
</script>
```

`prefers-color-scheme` kann als Fallback für Widgets dienen, die auch außerhalb von DucKI aufgerufen werden. Innerhalb des Hosts haben die URL-Parameter Vorrang. Die mitgelieferten Uhr-, News- und Kalender-Widgets implementieren dieses Protokoll.

Im Plugin-Bereich öffnet `Widgets (n)` den Style-Editor. Er verändert ausschließlich `title`, `placement`, `align`, `frame`, `background`, `height` und `width`. ID und Seite bleiben manifest-owned. Nach dem Speichern werden die serverseitig validierten Werte sofort in den lokalen und gemeinsamen Plugin-Cache übernommen; ein Seiten-Reload ist nicht erforderlich.

## 5. Einstellungs-, Frontend- und Overlay-Seiten

```json
{
  "provides": {
    "settingsPage": "settings/index.html",
    "frontendPage": "frontend/index.html",
    "overlayPage": "overlay/index.html"
  }
}
```

- `settingsPage` erscheint innerhalb der Plugin-Karte.
- `frontendPage` erhält bei aktivem Plugin einen Sidebar-Eintrag in `category`.
- `overlayPage` wird global transparent eingebettet und ist für HUDs oder Begleiter gedacht.
- Alle Seiten werden mit restriktiven iframe-/CSP-Regeln ausgeliefert. Geheimnisse dürfen niemals in HTML geschrieben werden.

## 6. Plugin-Einstellungen und Secrets

```json
{
  "provides": {
    "settings": [
      { "key": "WEATHER_CITY", "type": "string", "default": "Berlin", "description": "Standardort" },
      { "key": "WEATHER_API_KEY", "type": "secret", "required": true },
      { "key": "WEATHER_UNITS", "type": "select", "options": ["metric", "imperial"] }
    ]
  }
}
```

Typen: `string`, `number`, `boolean`, `select`, `secret`. Secrets werden verschlüsselt gespeichert und von der API nicht im Klartext zurückgegeben. Script-/Module-Tools erhalten normale Werte über `toolContext.settings` und Geheimnisse über `toolContext.secrets`.

## 7. Tool-Typen

### Deklaratives Data-Source-Tool

```json
{
  "name": "exchange_rates",
  "description": "Aktuelle Wechselkurse",
  "params": {
    "base": { "type": "string", "description": "ISO-Code" }
  },
  "defaults": { "base": "EUR" },
  "requests": [
    { "urlTemplate": "https://open.er-api.com/v6/latest/{base}" }
  ],
  "response": {
    "summaryTemplate": "1 {base} = {rates.USD} USD"
  },
  "allowedHosts": ["open.er-api.com"],
  "cacheTtlMs": 3600000
}
```

Dieser Typ ist bevorzugt für einfache HTTP-APIs: kein frei ausführbarer Node-Code, Host-Allowlist und Cache sind deklarativ.

### Sandboxed Script-Tool

```json
{
  "name": "notes",
  "description": "Notizen verwalten",
  "parameters": {
    "type": "object",
    "properties": { "action": { "type": "string" } },
    "required": ["action"]
  },
  "async": true,
  "script": "return { action: toolInput.action };"
}
```

Das Script erhält `toolInput` und bei asynchroner Ausführung `toolContext`. Mit `storage.sqlite: true` stehen `toolContext.storage.query(...)` und `toolContext.storage.exec(...)` zur Verfügung. Synchron ausgeführte sandboxed Scripts erhalten bewusst keine Secrets und keinen Netzwerkzugriff.

### Node Module-Tool

Benötigt `trust: "node"`. Das ESM-Modul exportiert `definition` und `execute(input, context)`. Der Kontext enthält:

- `pluginName`
- `storage`
- `settings`
- `secrets`
- host-geprüftes `fetch`
- Plugin-Logger
- bei Node-Trust optionale Agent-Capabilities

Node-Module sind nur für manuell geprüfte Plugins gedacht und werden vom allgemeinen Agent-Builder nicht erzeugt.

## 8. LLM-Provider als Plugin

```json
{
  "name": "acme-provider",
  "version": "1.0.0",
  "description": "Acme LLM Provider",
  "trust": "node",
  "provides": {
    "llmProviders": [{
      "id": "acme",
      "name": "Acme",
      "module": "provider.js",
      "modelSetting": "ACME_MODEL",
      "baseUrlSetting": "ACME_BASE_URL",
      "apiKeySetting": "ACME_API_KEY",
      "defaultModel": "acme-small",
      "defaultBaseUrl": "https://api.acme.example/v1"
    }]
  }
}
```

```js
export function createProvider(config, context) {
  return context.createOpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model
  }, "acme");
}
```

Provider-IDs müssen global eindeutig sein und dürfen Built-ins (`openai`, `openrouter`, `lmstudio`, `ollama`, `claude`) nicht überschreiben. Der zurückgegebene Provider implementiert die normale Provider-Schnittstelle einschließlich `listModels()`, sodass die Settings-UI Modelle dynamisch abrufen kann. Weitere Details stehen in `docs/llm-provider-plugins.md`.

## 9. OAuth und Connectoren

OAuth-Dateien definieren `id`, `authUrl`, `tokenUrl`, `scopes`, `clientIdSetting`, `clientSecretSetting`, `storeTokenAs` sowie optional `storeRefreshTokenAs` und zusätzliche `authParams`. Das Zugriffstoken wird als Plugin-Secret gespeichert.

Ein Connector wird mit `{ "module": "connector.js", "portal": "discord" }` registriert, benötigt `trust: "node"` und exportiert eine Factory für einen langlebigen Adapter mit Connect/Disconnect/Send/Status. Connectoren werden wegen ihrer Rechte nicht vom Agent-Builder erstellt.

## 10. Plugin-Builder

Der Builder erstellt zuerst eine feste Struktur. Systemdateien werden gehasht und dürfen vom isolierten Coding-Agent nicht verändert werden. Der Agent darf nur explizit freigegebene Dateien füllen. Unerwartete, fehlende oder veränderte Dateien lassen die abschließende Prüfung scheitern.

Archetypen:

- `data-source`: deklaratives API-Tool plus Usage-Skill
- `storage-tool`: sandboxed Script-Tool mit eigener SQLite-Datenbank plus Usage-Skill
- `llm-provider`: systemgesperrter OpenAI-kompatibler Adapter plus Usage-Skill
- `widget`: ein oder mehrere systemdefinierte Widgets; Agent bearbeitet nur Widget-HTML und README

Builder-Spezifikation enthält gemeinsam: `name`, `displayName`, `description`, `category`, `archetype`, `userRequest`; optional `icon`, `targetHint`, `allowedHosts`, `api`, `llmProvider` oder `widgets`.

Interne HTTP-API:

```text
POST /api/plugins/builder/preview
POST /api/plugins/create-run
GET  /api/plugins/builder/runs/<run-id>
POST /api/plugins/reload
POST /api/plugins/validate
```

Plugin-Erstellung ist asynchron. `create-run` liefert eine `runId`; Statuswerte sind `running`, `completed`, `failed` und `stopped`. Erfolgreich erzeugte Plugins werden deaktiviert installiert und benötigen manuelle Aktivierung.

## 11. Internes Agent-Mapping

Nur der primäre Gesprächsagent erhält `builder_management`; Bots und Workflows erhalten es nicht. Aktionen:

- `capabilities`: Verträge, Archetypen und aktuellen Modus abfragen
- `preview`: geplante Struktur validieren, ohne sie zu installieren
- `create`: Plugin-Run starten oder Skill atomar erstellen
- `status`: asynchronen Plugin-Run abfragen

Für `create` ist `trigger` erforderlich:

- `user-request`: der Benutzer hat die Erstellung angefordert
- `autonomous`: nur erlaubt, wenn `BUILDER_AGENT_MODE=autonomous`

Einstellungen:

- `PLUGIN_CREATION_ENABLED`: Plugin-Builder freigeben; benötigt zusätzlich den aktivierten Coding-Bereich
- `SKILL_CREATION_ENABLED`: Skill-Builder freigeben
- `BUILDER_AGENT_MODE`: `manual`, `suggest` oder `autonomous`

## 12. Skill-Builder und manuelle Skills

Minimale Struktur:

```text
skills/my-skill/
└── SKILL.md
```

```markdown
---
name: my-skill
description: Beschreibt präzise, was der Skill tut und wann er verwendet werden soll.
---

# Zweck

Nur nicht offensichtliche, entscheidungsrelevante Anweisungen gehören hierher.
```

Optionale Ressourcen:

```text
agents/openai.yaml   UI-Metadaten und Invocation Policy
scripts/             deterministische Hilfsprogramme
references/          nur bei Bedarf zu lesende Detaildokumentation
assets/              Dateien für erzeugte Ergebnisse
```

Der interne Skill-Builder akzeptiert:

- `name`: lowercase-kebab, maximal 64
- `description`: 20–1024 Zeichen, Fähigkeit und Auslösefall
- `instructions`: Markdown-Body ohne Frontmatter, 40–80.000 Zeichen
- `compatibility`: optional, maximal 500 Zeichen
- `resources`: maximal 20 Dateien unter `references/`, `scripts/` oder `assets/`, je maximal 200.000 Zeichen

Der Builder besitzt das Frontmatter, schreibt zunächst in `.builder-staging`, prüft mit demselben `validateSkillContent`/`validateSkillDirectory` wie der Loader und benennt erst danach atomar in den endgültigen Skill-Ordner um. Doppelte Ressourcenpfade und `..`-Traversal werden abgelehnt.

Skill-Builder-API:

```text
POST /api/skills/builder/preview
POST /api/skills/builder/create
```

## 13. Manueller Entwicklungsablauf

1. Eindeutigen lowercase-kebab Ordner anlegen.
2. `plugin.json` erstellen und Namen exakt dem Ordner anpassen.
3. Mit `trust: "sandboxed"` beginnen und nur bei zwingendem Bedarf auf Node-Trust wechseln.
4. `allowedHosts` so eng wie möglich setzen.
5. Bereitgestellte Dateien in `provides` eintragen und relative Pfade verwenden.
6. Plugin-Verzeichnis über `POST /api/plugins/reload` neu einlesen oder in der Plugin-Seite „Aktualisieren“ wählen.
7. Fehler in der Plugin-Liste beheben; fehlerhafte Plugins werden nicht aktiv geladen.
8. Widget-Seiten direkt über ihre `/api/plugins/.../ui/widgets/.../`-URL testen.
9. Plugin zunächst deaktiviert testen und erst nach Prüfung aktivieren.

Für Builder-kompatible Validierung kann die CLI verwendet werden:

```text
node <validate-cli.js> <plugins-root> <plugin-name>
node <validate-cli.js> <plugins-root> <plugin-name> --allow-builder-widgets
node <validate-cli.js> <plugins-root> <plugin-name> --allow-builder-llm-provider
```

Die beiden `--allow-builder-*`-Schalter sind ausschließlich für systemgenerierte und integritätsgesperrte Builder-Scaffolds vorgesehen, nicht als pauschale Freigabe für beliebigen Agent-Code.

## 14. Sicherheitsregeln

- Niemals Secrets in Manifest, HTML, README oder Logs schreiben.
- `trust: "node"` als Codeausführungsfreigabe behandeln.
- Netzwerkzugriffe mit `allowedHosts` begrenzen.
- Widget-, UI- und Ressourcenpfade müssen im Plugin-Ordner bleiben.
- Vom Agenten erstellte Plugins dürfen keine Module, Connectoren, OAuth-Flows oder beliebige UI-Seiten einschleusen; Widgets und LLM-Provider sind nur über gesperrte Builder-Scaffolds erlaubt.
- Plugin-Aktivierung bleibt eine Benutzerentscheidung.
- Autonome Builder-Aufrufe benötigen den expliziten Modus `autonomous`.
