# Skill: Git Operations

## Zusammenfassung
Sichere und effektive Git-Workflows. Commits, Branches, Pushes - alles mit Best Practices für saubere Versionskontrolle und kollaboratives Arbeiten.

## Kernfunktionen

### 1. Status überprüfen
```
[TOOL:git({"action": "status"})]
```

**Wann nutzen:**
- IMMER vor commits/pushes
- Um zu sehen was sich geändert hat
- Unerwartete Dateien finden
- Branch-Status überprüfen

**Workflow:**
```
[TOOL:git({"action": "status"})]
// Überprüfe: Welche Dateien changed? Untracked files? Branch?
// DANN erst commit/push!
```

### 2. Änderungen stagen (add)
```
[TOOL:git({"action": "add", "files": ["src/main.ts", "src/utils.ts"]})]
```

**Wann nutzen:**
- Spezifische Dateien für Commit vorbereiten
- NICHT alle Dateien zusammen (nie `git add .`!)
- Logische Gruppen zusammen stagen

⚠️ **WICHTIG:**
- Immer spezifische Dateien nennen!
- Nicht versehentlich Secrets/Credentials stagen!
- Überprüfe staged files vor commit!

### 3. Commit erstellen
```
[TOOL:git({"action": "commit", "message": "Fix: authentication timeout issue\n\nDetails of the fix..."})]
```

**Wann nutzen:**
- Nach logische Änderungen durchführen
- Gute Commit-Messages schreiben
- Regelmäßig committen (nicht am Ende)

**Commit-Message Format:**
```
[Type]: [Short description]

[Longer explanation if needed]
```

Types: `fix:`, `feat:`, `refactor:`, `docs:`, `test:`, `chore:`

**GUTE Commits:**
```
fix: handle null pointer in user authentication

When user logs in without complete profile data,
the system was throwing an unhandled exception.
This fix gracefully handles missing fields.
```

**SCHLECHTE Commits:**
```
update
fixed stuff
bug fixes and improvements
```

### 4. Branch erstellen
```
[TOOL:git({"action": "branch", "name": "feature/new-auth-system"})]
```

**Wann nutzen:**
- Für neue Features: `feature/name`
- Für Fixes: `fix/description`
- Für Experiments: `experiment/idea`

**Branch-Naming:**
- `feature/` - neue Features
- `fix/` - Bug-Fixes
- `refactor/` - Code-Umbauten
- `docs/` - Dokumentation
- `test/` - Test-Verbesserungen

### 5. Branch wechseln
```
[TOOL:git({"action": "checkout", "branch": "feature/new-feature"})]
```

**Wann nutzen:**
- Zwischen Branches navigieren
- Feature-Branches starten
- Zurück zu main wechseln

⚠️ **WARNUNG:**
- Uncomitted changes checken!
- Nicht über uncommitted work wechseln
- `git status` vor checkout!

### 6. Push zu Remote
```
[TOOL:git({"action": "push", "branch": "feature/my-feature"})]
```

**Wann nutzen:**
- Nach lokalen Commits remote synchen
- Backup der Arbeit in die Cloud
- Andere können Code reviewen

**Sicherer Workflow:**
```
[TOOL:git({"action": "status"})]                    // Status checken
[TOOL:git({"action": "add", "files": [...]})]       // Files stagen
[TOOL:git({"action": "commit", "message": "..."})]  // Committen
[TOOL:git({"action": "push", "branch": "..."})]     // Pushen
```

### 7. Pull von Remote
```
[TOOL:git({"action": "pull", "branch": "main"})]
```

**Wann nutzen:**
- Änderungen von Teamkollegen holen
- Auf main mit main synchen
- Bevor man neue Branches erstellt

### 8. Merge durchführen
```
[TOOL:git({"action": "merge", "source": "feature/complete-feature", "into": "main"})]
```

**Wann nutzen:**
- Feature-Branches in main mergen
- Nach Code-Review abgeschlossen
- Pull Request merged

⚠️ **VORSICHT:**
- Merge-Konflikte sind möglich
- Vor merge testen!
- Immer code review vorher

### 9. Commits anschauen
```
[TOOL:git({"action": "log", "limit": 10})]
```

**Wann nutzen:**
- Historie verstehen
- Letzte Commits sehen
- Commit-Messages lesen
- Wer was geändert hat

### 10. Änderungen anschauen
```
[TOOL:git({"action": "diff"})]
```

**Wann nutzen:**
- Unstaged Änderungen sehen
- Vor commit überprüfen
- Was genau hat sich geändert?

## Sicherer Git-Workflow (Gold Standard)

```
1. [TOOL:git({"action": "status"})]
   └─ Unerwartete Datei? Uncommitted work?

2. [TOOL:git({"action": "pull", "branch": "main"})]
   └─ Mit main synchronisieren

3. [TOOL:git({"action": "branch", "name": "feature/my-work"})]
   └─ Feature-Branch erstellen

4. [TOOL:git({"action": "checkout", "branch": "feature/my-work"})]
   └─ Zur Branch wechseln

5. [... Arbeit durchführen ...]
   └─ Code editieren, testen

6. [TOOL:git({"action": "status"})]
   └─ Was geändert?

7. [TOOL:git({"action": "add", "files": ["specific", "files"]})]
   └─ Relevante Dateien stagen

8. [TOOL:git({"action": "commit", "message": "feat: implement new feature\n\nDetails..."})]
   └─ Logical commit erstellen

9. [TOOL:git({"action": "push", "branch": "feature/my-work"})]
   └─ Zu Remote pushen

10. [Pull Request erstellen via Web]
    └─ Code Review anfordern

11. [Nach Review approval]
    [TOOL:git({"action": "merge", "source": "feature/my-work", "into": "main"})]
    └─ In main mergen
```

## Branching Strategy

### Main Branch
- ✅ Immer deployable
- ✅ Nur getesteter Code
- ✅ Nur über Pull Requests
- ❌ Direkte Commits auf main

### Feature Branches
- Naming: `feature/descriptive-name`
- Basiert auf: `main`
- Merged in: `main` (via PR)
- Kurz gelebt: max 1-2 Wochen

### Hotfix Branches
- Naming: `fix/critical-issue`
- Für Production-Bugs
- Schnell mergen
- Sofort testen!

## Häufige Fehler

❌ **Problem:** Alle Änderungen zusammen committen
```
[TOOL:git({"action": "add", "files": ["."]})]  // NEIN!
[TOOL:git({"action": "commit", "message": "update"})]
```

✅ **Lösung:**
```
[TOOL:git({"action": "add", "files": ["src/feature.ts", "test/feature.test.ts"]})]
[TOOL:git({"action": "commit", "message": "feat: implement feature X"})]
[TOOL:git({"action": "add", "files": ["docs/README.md"]})]
[TOOL:git({"action": "commit", "message": "docs: update README with feature X"})]
```

❌ **Problem:** Credentials committen
```
[TOOL:git({"action": "add", "files": [".env"]})]  // NEIN! SECRETS!
```

✅ **Lösung:**
- `.env` in `.gitignore` eintragen
- `.env.example` mit dummy values committen
- Real `.env` lokal speichern

## Merge Konflikte

Wenn Merge fehlschlägt:

```
1. [TOOL:git({"action": "status"})]
   └─ Konflikt-Dateien sehen

2. [TOOL:filesystem({"action": "read", "path": "conflicted-file.ts"})]
   └─ Konflikt anschauen (<<<<<<< HEAD, =======, >>>>>>>)

3. [Manuell den Konflikt lösen]
   └─ Richtige Version wählen

4. [TOOL:filesystem({"action": "write", "path": "conflicted-file.ts", "content": "..."})]
   └─ Gelöste Datei speichern

5. [TOOL:git({"action": "add", "files": ["conflicted-file.ts"]})]
   └─ Gelöst markieren

6. [TOOL:git({"action": "commit", "message": "merge: resolve conflicts from main"})]
   └─ Merge committen
```

## Performance-Tips

⚡ **Schnell:**
- Häufige kleine Commits
- Kurze Branch-Lifetimes
- Pull Requests schnell reviewen

🐌 **Langsam:**
- Riesige Commits
- Branches monatelang offen
- Merge-Konflikte aufschieben

## Integration mit anderem Skills

- **filesystem:** Code editieren, dann git commit
- **shell:** Tests laufen, dann git commit
- **skill_manage:** Skills sind auch versionskontrolliert!

## Kritische Regeln

🔴 **NIEMALS:**
- `git push --force` (außer mit Grund)
- Secrets/credentials committen
- Uncommitted work nicht backen
- Main ohne Tests pushen

🟢 **IMMER:**
- `git status` vor wichtigen Ops
- Aussagekräftige Commit-Messages
- Kurze Branches (max 2 Wochen)
- Code reviewen lassen vor Merge
