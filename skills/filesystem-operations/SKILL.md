# Skill: Filesystem Operations

## Zusammenfassung
Sicheres und effizientes Arbeiten mit dem Dateisystem über das `filesystem`-Tool.
Alle Pfade sind auf `shared-workspace` beschränkt (ausser `basePath`/`safeMode:false` ist gesetzt).

## Verzeichnis oder Datei? (WICHTIG — häufigste Fehlerquelle)

Verzeichnisse und Dateien brauchen **unterschiedliche Actions**:

| Ziel | Richtig | Falsch |
|---|---|---|
| Ordnerinhalt sehen (`./shared-workspace`) | `list` | ~~`read`~~ |
| Dateiinhalt lesen (`./shared-workspace/notes.md`) | `read` | ~~`list`~~ |
| Unklar, was der Pfad ist | `stat` (liefert `isDirectory`) | raten |

Faustregel: **Pfad ohne Dateiendung → zuerst `list` oder `stat`.**

```
# Ordner erkunden
[TOOL:filesystem({"action": "list", "path": "./shared-workspace"})]
# dann gezielt eine Datei daraus lesen
[TOOL:filesystem({"action": "read", "path": "./shared-workspace/report.md"})]
```

`read` auf einem Verzeichnis liefert seit Kurzem hilfsweise die Ordnerliste plus einen
Hinweis — verlasse dich aber nicht darauf, nimm gleich `list`.

## Alle Actions

| Action | Zweck | Pflichtfelder |
|---|---|---|
| `read` | Dateiinhalt lesen | `path` |
| `write` | Datei anlegen/komplett überschreiben | `path`, `content` |
| `append` | Inhalt anhängen | `path`, `content` |
| `edit` | Exakten Textabschnitt ersetzen | `path`, `oldString`, `newString` |
| `delete` | Datei/Ordner löschen | `path` (Ordner: `recursive:true`) |
| `list` | Ordnerinhalt auflisten | `path` |
| `mkdir` | Ordner anlegen (rekursiv) | `path` |
| `exists` | Existenz prüfen | `path` |
| `stat` | Grösse, Zeitstempel, `isDirectory` | `path` |
| `move` | Verschieben/umbenennen | `path`, `destination` |
| `copy` | Einzelne Datei kopieren | `path`, `destination` |
| `glob` | Dateien per Muster finden | `path`, `pattern` |
| `grep` | Dateiinhalte per Regex durchsuchen | `path`, `pattern` |

## Kernfunktionen

### Lesen — auch teilweise
```
[TOOL:filesystem({"action": "read", "path": "config.json"})]
```
Grosse Dateien abschnittsweise lesen statt alles auf einmal:
```
[TOOL:filesystem({"action": "read", "path": "server.log", "offset": 200, "limit": 100})]
```
- `offset` = erste Zeile (0-basiert), `limit` = Anzahl Zeilen
- `maxBytes` (Default 262144) kappt die Ausgabe; die Antwort sagt dir, wenn gekürzt wurde

### Ändern — `edit` statt `write` bevorzugen
```
[TOOL:filesystem({"action": "edit", "path": "src/main.ts", "oldString": "const port = 3000", "newString": "const port = 8080"})]
```
- `oldString` muss **exakt einmal** vorkommen, sonst kommt ein Fehler mit der Trefferzahl
  → mehr Kontext mitgeben oder `replaceAll:true` setzen
- `write` überschreibt die **ganze** Datei — nur für neue Dateien oder Vollersatz
- `write`/`append` legen ein `.bak` an und schreiben atomar; JSON wird vor dem Schreiben validiert

### Anlegen
```
[TOOL:filesystem({"action": "write", "path": "my-project/README.md", "content": "# My Project"})]
```
Übergeordnete Ordner entstehen automatisch (`createDirs`, Default true) — separates `mkdir`
ist nur nötig, wenn du einen leeren Ordner brauchst.

### Suchen statt raten
```
[TOOL:filesystem({"action": "glob", "path": "./shared-workspace", "pattern": "**/*.ts"})]
[TOOL:filesystem({"action": "grep", "path": "./shared-workspace", "pattern": "TODO|FIXME", "filePattern": "**/*.ts"})]
```
Nutze das, statt Ordner für Ordner mit `list` durchzugehen.

### Verschieben, kopieren, löschen
```
[TOOL:filesystem({"action": "move", "path": "alt.txt", "destination": "neu.txt"})]
[TOOL:filesystem({"action": "copy", "path": "config.json", "destination": "config.json.bak"})]
[TOOL:filesystem({"action": "delete", "path": "tmp", "recursive": true})]
```
- `move`/`copy` brauchen `path` **und** `destination` (nicht `from`/`to`)
- `copy` kopiert nur einzelne Dateien — für Ordner das `shell`-Tool nehmen
- `delete` auf einem Ordner ohne `recursive:true` wird abgelehnt

### Trockenlauf
Fast alle schreibenden Actions akzeptieren `dryRun:true` — prüft und meldet, ohne etwas zu ändern.

## Sichere Workflows

### Bestehende Datei ändern
```
1. [TOOL:filesystem({"action": "read", "path": "important.conf"})]
2. [TOOL:filesystem({"action": "edit", "path": "important.conf", "oldString": "[exakter alter Abschnitt]", "newString": "[neuer Abschnitt]"})]
```
Das `.bak` legt das Tool selbst an — ein extra `copy` ist nicht nötig.

### Unbekanntes Verzeichnis erkunden
```
1. [TOOL:filesystem({"action": "list", "path": "./shared-workspace"})]
2. [TOOL:filesystem({"action": "glob", "path": "./shared-workspace", "pattern": "**/*.md"})]
3. [TOOL:filesystem({"action": "read", "path": "[konkrete Datei aus Schritt 1/2]"})]
```

## Fehler richtig lesen

Das Tool antwortet mit klaren, handlungsfähigen Meldungen — folge ihnen, statt aufzugeben:

| Meldung | Was zu tun ist |
|---|---|
| `'…' is a file, not a directory` | `read` statt `list` |
| `'…' is a directory, not a file` | `list` statt `read`/`edit`/`append` |
| `oldString is not unique (N matches)` | mehr Kontext in `oldString`, oder `replaceAll:true` |
| `oldString not found in file` | Datei erst `read`, exakten Text übernehmen |
| `Path is outside shared workspace` | Pfad unter `shared-workspace` legen oder `basePath` setzen |
| `is a directory. Pass recursive:true` | `recursive:true` ergänzen |

## Grössen-Guidelines

- **Klein** (<256KB): direkt `read`
- **Gross**: `read` mit `offset`/`limit` abschnittsweise, oder vorher `grep` zum Eingrenzen
- **Schreiben grosser Dateien**: erst `write`, dann `append` in Teilen (siehe Skill `large-file-writing`)
- **Binärdateien**: nicht mit `read`/`write` bearbeiten

## Häufige Fehler

❌ `read` auf einen Ordner
```
[TOOL:filesystem({"action": "read", "path": "./shared-workspace"})]
```
✅ `list` benutzen
```
[TOOL:filesystem({"action": "list", "path": "./shared-workspace"})]
```

❌ Ganze Datei überschreiben für eine Zeile
```
[TOOL:filesystem({"action": "write", "path": "config.json", "content": "[komplette Datei]"})]
```
✅ Gezielt ersetzen
```
[TOOL:filesystem({"action": "edit", "path": "config.json", "oldString": "\"port\": 3000", "newString": "\"port\": 8080"})]
```

❌ `from`/`to` bei move/copy — diese Felder gibt es nicht
✅ `path` + `destination`

## Integration mit anderen Tools

- **git:** Dateien ändern, dann `git add` + `git commit`
- **shell:** Skripte erzeugen und ausführen, rekursives Kopieren
- **http:** Heruntergeladene Inhalte in `shared-workspace` ablegen
