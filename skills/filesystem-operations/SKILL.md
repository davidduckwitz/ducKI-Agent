# Skill: Filesystem Operations

## Zusammenfassung
Sicheres und effizientes Arbeiten mit dem Dateisystem. Erstelle, lese, bearbeite und lösche Dateien/Ordner mit Best Practices für Sicherheit und Struktur.

## Kernfunktionen

### 1. Datei lesen
```
[TOOL:filesystem({"action": "read", "path": "/path/to/file.txt"})]
```

**Wann nutzen:**
- Datei-Inhalt laden und analysieren
- Konfigurationsdateien auslesen
- Vor Änderungen bestehende Inhalte checken

**Best Practice:**
```
# Immer vor edit/write die aktuelle Datei lesen!
[TOOL:filesystem({"action": "read", "path": "config.json"})]
# ... Änderungen planen ...
[TOOL:filesystem({"action": "write", "path": "config.json", "content": "[neue Version]"})]
```

### 2. Datei schreiben/erstellen
```
[TOOL:filesystem({"action": "write", "path": "/path/to/new-file.txt", "content": "Datei-Inhalt"})]
```

**Wann nutzen:**
- Neue Dateien erstellen
- Bestehende Dateien vollständig überschreiben
- Konfigurationen speichern

⚠️ **WARNUNG:**
- `write` überschreibt bestehende Dateien KOMPLETT
- Immer vorher lesen wenn Datei existiert!
- Backups erwägen für wichtige Dateien

### 3. Verzeichnis erstellen
```
[TOOL:filesystem({"action": "mkdir", "path": "/path/to/new-dir"})]
```

**Wann nutzen:**
- Neue Projekt-Strukturen aufbauen
- Organisierte Ordner-Hierarchie erstellen

### 4. Datei löschen
```
[TOOL:filesystem({"action": "delete", "path": "/path/to/file.txt"})]
```

**Wann nutzen:**
- Alte/temporäre Dateien aufräumen
- Veraltete Konfigurationen entfernen

⚠️ **VORSICHT:**
- Löschen ist permanent!
- Immer Pfad doppelt überprüfen
- Kritische Dateien vorher lesen!

### 5. Datei kopieren
```
[TOOL:filesystem({"action": "copy", "from": "/old/path", "to": "/new/path"})]
```

**Wann nutzen:**
- Backups erstellen
- Template-Dateien duplizieren
- Sichere Duplikate vor Änderungen

### 6. Datei verschieben
```
[TOOL:filesystem({"action": "move", "from": "/old/path", "to": "/new/path"})]
```

**Wann nutzen:**
- Dateien reorganisieren
- Umstrukturierung von Projekten

### 7. Datei-Info (Metadaten)
```
[TOOL:filesystem({"action": "info", "path": "/path/to/file"})]
```

**Wann nutzen:**
- Größe einer Datei überprüfen
- Letzten Änderungszeitpunkt sehen
- Existenz verifizieren vor Operationen

## Sichere Workflows

### Workflow 1: Sichere Bearbeitung
```
1. [TOOL:filesystem({"action": "read", "path": "important.conf"})]
   └─ Aktuellen Inhalt laden

2. [TOOL:filesystem({"action": "copy", "from": "important.conf", "to": "important.conf.backup"})]
   └─ Backup erstellen

3. [TOOL:filesystem({"action": "write", "path": "important.conf", "content": "[neue Version]"})]
   └─ Sichere Änderung durchführen
```

### Workflow 2: Projekt-Struktur aufbauen
```
[TOOL:filesystem({"action": "mkdir", "path": "my-project/src"})]
[TOOL:filesystem({"action": "mkdir", "path": "my-project/tests"})]
[TOOL:filesystem({"action": "mkdir", "path": "my-project/docs"})]
[TOOL:filesystem({"action": "write", "path": "my-project/README.md", "content": "# My Project"})]
```

## Pfad-Konventionen

### Absolute Pfade (empfohlen)
```
/home/user/project/src/file.ts
```
- Eindeutig und zuverlässig
- Funktionieren überall
- Verwende diese im Production-Code

### Relative Pfade (nur für Klarheit)
```
./src/file.ts
../utils/helper.ts
```
- Nur verwenden wenn Kontext klar ist
- Im Agent-Output für Lesbarkeit ok
- Im Automation-Code: absolute Pfade!

## Sicherheits-Best-Practices

✅ **TUN:**
- Pfade validieren vor Operationen
- Backups für kritische Dateien
- Lesbar strukturierte Verzeichnisse
- Consistent file naming conventions
- Logs für Audit-Trail

❌ **NICHT TUN:**
- Pfade from untrusted input direkt nutzen
- Kritische Dateien ohne Backup löschen
- Wild verschachtelte Verzeichnisse
- Sensitive Daten in Klartext speichern
- Permissions ignorieren

## Größen-Guidelines

- **Kleine Dateien** (<1MB): direkt mit `read` laden
- **Mittlere Dateien** (1-10MB): in Chunks bearbeiten
- **Große Dateien** (>10MB): Streaming oder git nutzen
- **Binäre Dateien**: Nicht mit `read`/`write` - nutze spezielle Tools

## File-Type Spezifisches

### JSON Dateien
```javascript
[TOOL:filesystem({"action": "read", "path": "config.json"})]
// Parse JSON, modify, stringify
[TOOL:filesystem({"action": "write", "path": "config.json", "content": JSON.stringify(modified, null, 2)})]
```

### Markdown Dateien
```
[TOOL:filesystem({"action": "read", "path": "README.md"})]
// Edit markdown, maintain formatting
[TOOL:filesystem({"action": "write", "path": "README.md", "content": "# Updated\n..."})]
```

### Code Dateien
```
[TOOL:filesystem({"action": "read", "path": "src/main.ts"})]
// IMMER: lesen vor edit
// IMMER: strukturelle Änderungen planen
// IMMER: Tests nach Änderungen
[TOOL:filesystem({"action": "write", "path": "src/main.ts", "content": "[neuer Code]"})]
```

## Häufige Fehler

❌ **Problem:** Datei überschreiben ohne Backup
```
[TOOL:filesystem({"action": "write", "path": "important.json", "content": "..."})]
// Oops! Alte Daten weg!
```

✅ **Lösung:**
```
[TOOL:filesystem({"action": "read", "path": "important.json"})]      // Backup im Kopf
[TOOL:filesystem({"action": "copy", "from": "important.json", "to": "important.json.bak"})]  // Sichern
[TOOL:filesystem({"action": "write", "path": "important.json", "content": "..."})]  // Update
```

## Integration mit anderen Tools

- **Mit git:** Dateien ändern, dann `git add` + `git commit`
- **Mit shell:** Script-Dateien erstellen, dann `shell` tool zum Ausführen
- **Mit skill_manage:** Skills sind auch nur Dateien in `skills/`-Ordner

## Performance-Tipps

⚡ **Schnell:**
- Kleine, fokussierte Dateien
- Keine unnötigen Lese-Operationen
- Batching: mehrere Dateien zusammen verarbeiten

🐌 **Langsam:**
- Große Dateien komplett laden
- Wiederholte reads der gleichen Datei
- Deep nesting ohne Grund
