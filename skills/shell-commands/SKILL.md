# Skill: Shell Commands

## Zusammenfassung
Effiziente und sichere Shell-Befehle ausführen. Scripts, System-Tasks, Prozesse - alles mit Best Practices für Sicherheit und Zuverlässigkeit.

## Kernfunktionen

### 1. Einzelner Befehl ausführen
```
[TOOL:shell({"command": "ls -la"})]
```

**Wann nutzen:**
- Quick status checks
- Files/directories auflisten
- Prozesse überprüfen
- System-Info anschauen

### 2. Arbeitsverzeichnis setzen
```
[TOOL:shell({"command": "cd /path/to/project && npm install"})]
```

**Wann nutzen:**
- Befehle in bestimmtem Verzeichnis ausführen
- Project-Kontext für Commands
- Path-abhängige Operationen

**Best Practice:**
```
[TOOL:shell({"command": "cd /home/user/my-project && pwd"})]
└─ Bestätige dass du im richtigen Dir bist!
```

### 3. Build-Befehle
```
[TOOL:shell({"command": "npm run build"})]
[TOOL:shell({"command": "cargo build --release"})]
[TOOL:shell({"command": "python setup.py build"})]
```

**Wann nutzen:**
- Projekt kompilieren
- Abhängigkeiten installieren
- Artifacts generieren

⚠️ **WICHTIG:**
- Immer build-output lesen
- Auf Fehler prüfen
- Build-Zeit beachten (kann lange dauern!)

### 4. Tests ausführen
```
[TOOL:shell({"command": "npm test"})]
[TOOL:shell({"command": "cargo test"})]
[TOOL:shell({"command": "pytest tests/"})]
```

**Wann nutzen:**
- Nach Code-Änderungen testen
- Regression-Tests
- Vor Push zum Remote
- Sicherstellen dass nichts broken ist

**GOLDENE REGEL:**
- Tests IMMER vor Commit/Push
- Grüne Tests = safe to commit
- Failing Tests = nicht committen!

### 5. Prozesse verwalten
```
[TOOL:shell({"command": "ps aux | grep node"})]
[TOOL:shell({"command": "kill -9 <PID>"})]
[TOOL:shell({"command": "lsof -i :3000"})]
```

**Wann nutzen:**
- Laufende Prozesse sehen
- Server stoppen
- Port-Konflikte checken
- Debug-Prozesse beenden

### 6. Dateien verarbeiten
```
[TOOL:shell({"command": "find . -name '*.tmp' -delete"})]
[TOOL:shell({"command": "grep -r 'TODO' src/"})]
[TOOL:shell({"command": "wc -l src/main.ts"})]
```

**Wann nutzen:**
- Bulk-Operationen
- Pattern-Suche
- File-Statistiken
- Cleanup

### 7. Environment-Variables
```
[TOOL:shell({"command": "echo $NODE_ENV"})]
[TOOL:shell({"command": "export DEBUG=true && npm start"})]
```

**Wann nutzen:**
- Config überprüfen
- Dynamische Werte setzen
- Environment-spezifische Commands

### 8. Pipe & Redirection
```
[TOOL:shell({"command": "npm list | grep lodash"})]
[TOOL:shell({"command": "npm test > test-results.txt 2>&1"})]
[TOOL:shell({"command": "cat config.json | jq '.database'"})]
```

**Wann nutzen:**
- Output filtern
- Results in Dateien speichern
- JSON parsen & manipulieren
- Logs analysieren

## Sichere Shell-Workflows

### Workflow 1: Build & Test
```
1. [TOOL:shell({"command": "cd my-project && pwd"})]
   └─ Dir überprüfen

2. [TOOL:shell({"command": "npm install"})]
   └─ Dependencies

3. [TOOL:shell({"command": "npm run build"})]
   └─ Build durchführen

4. [TOOL:shell({"command": "npm test"})]
   └─ Tests run

5. [Falls erfolgreich: SAFE TO COMMIT]
   [Falls fehler: FIX FIRST!]
```

### Workflow 2: Deployment Checklist
```
1. [TOOL:shell({"command": "git status"})]
   └─ Uncommitted? Abort!

2. [TOOL:shell({"command": "npm test"})]
   └─ Tests grün?

3. [TOOL:shell({"command": "npm run build"})]
   └─ Build ok?

4. [TOOL:shell({"command": "npm run deploy"})]
   └─ Deploy to production

5. [TOOL:shell({"command": "npm run smoke-tests"})]
   └─ Verification in prod
```

## Kommandos nach Typ

### Navigation
```bash
pwd                    # aktuelles Verzeichnis
cd /path/to/dir       # Verzeichnis wechseln
ls -la                # Dateien auflisten (mit hidden)
find . -name "*.js"   # Dateien finden
```

### Dateien
```bash
cat file.txt          # Datei anschauen
head -20 file.txt     # Erste 20 Zeilen
tail -50 file.txt     # Letzte 50 Zeilen
wc -l file.txt        # Zeilenanzahl
grep "pattern" file   # Pattern suchen
```

### Prozesse
```bash
ps aux                 # Alle Prozesse
ps aux | grep node    # Spezifischen Prozess finden
kill -9 <PID>         # Prozess beenden (forceful)
jobs                   # Background jobs
```

### Netzwerk
```bash
netstat -tuln | grep 3000   # Port 3000 prüfen
lsof -i :3000               # Was läuft auf Port 3000?
curl http://localhost:3000  # HTTP Request
```

### System
```bash
df -h                  # Disk space
du -sh .               # Verzeichnis-Größe
free -h                # RAM info
uname -a               # System info
```

## Best Practices

✅ **TUN:**
- Befehle vorher überprüfen
- Output lesen (ganz wichtig!)
- Error-Codes checken
- Test vorher lokal
- Logging aktivieren für wichtige Ops

❌ **NICHT TUN:**
- `rm -rf /` ohne zu prüfen (😱)
- Commands ohne Output-Überprüfung
- Sudo ohne Grund
- Destructive commands blind ausführen
- Production-Commands ohne Backup

## Error Handling

### Output überprüfen
```
[TOOL:shell({"command": "npm install"})]
// Output lesen:
// ✅ "added 123 packages"
// ❌ "ERR! code E404"
// ❌ "npm ERR!"
```

### Exit-Code prüfen
```bash
npm test ; echo $?  # 0 = success, anything else = error
```

### Stderr redirecten
```bash
npm build 2>&1      # Stderr + Stdout zusammen
npm build 2>/dev/null  # Errors ignorieren (sometimes ok)
```

## Lange Befehle

Für sehr lange oder komplexe Commands:
```
npm run build && \
npm test && \
git add . && \
git commit -m "feat: new feature"
```

Besser: Shell-Script schreiben
```bash
#!/bin/bash
cd /project
npm install
npm run build
npm test
```

## Performance-Tips

⚡ **Schnell:**
- Parallele Befehle `npm install & npm build`
- Caching nutzen
- Berechtigungen vor Ops überprüfen

🐌 **Langsam:**
- Große Dateien komplett lesen
- Rekursive Operationen auf big trees
- Netzwerk-Befehle ohne Timeout

## Integration mit anderen Tools

- **git:** Code ändern, dann `npm test` vor commit
- **filesystem:** Dateien erstellen, dann `npm build`
- **skill_manage:** Skills sind auch ausführbar!

## Kritische Regeln

🔴 **NIEMALS BLIND AUSFÜHREN:**
```
rm -rf /path
git push --force
sudo reboot
kill -9 $(pgrep node)
```

🟢 **IMMER ERST:**
```
Befehl überprüfen
Output lesen
Sicherheit überprüfen
Nur dann: Befehl ausführen
```

## Common Issues

### Port already in use
```
lsof -i :3000        # Was läuft da?
kill -9 <PID>        # Prozess killen
npm start             # Restart
```

### Build fehlgeschlagen
```
npm run clean        # Cache löschen
npm install          # Fresh dependencies
npm run build        # Retry
```

### Tests failing
```
npm test -- --verbose  # Details sehen
npm test -- one-test   # Einzelnen Test laufen
Debug + Fix + Retry
```

## Timeout Beachten

Lange Operationen:
- `npm install` auf großem Projekt: 5+ Minuten
- `npm test` mit Coverage: 10+ Minuten
- Build von großem Projekt: 15+ Minuten

Immer Zeit einkalkulieren, nicht interrupt wenn noch läuft!
