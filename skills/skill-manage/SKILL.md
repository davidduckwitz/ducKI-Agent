# Skill: Skill Management

## Zusammenfassung
Verwaltung von Skills (Markdown-basierte Wissenserweiterung). Der Agent kann damit seine eigenen Fähigkeiten erweitern, aktualisieren und verwalten.

## Kernfunktionen

### 1. Skill erstellen oder updaten
```
[TOOL:skill_manage({
  "action": "write",
  "name": "my-new-skill",
  "content": "# Skill: My Skill\n\n## Description\n..."
})]
```

**Wann nutzen:**
- Neue Fähigkeiten für spezifische Aufgaben hinzufügen
- Best Practices und Workflows dokumentieren
- Wiederverwendbare Patterns etablieren

### 2. Skill auflisten
```
[TOOL:skill_manage({
  "action": "list"
})]
```

**Wann nutzen:**
- Verfügbare Skills überprüfen
- Bevor man Operationen auf Skills macht
- Um zu sehen, welche Fähigkeiten bereits vorhanden sind

### 3. Skill ansehen
```
[TOOL:skill_manage({
  "action": "view",
  "name": "existing-skill"
})]
```

**Wann nutzen:**
- Bestehende Skills verstehen und lernen
- Vor Updates überprüfen, was bereits existiert
- Best Practices von anderen Skills übernehmen

### 4. Skill ausführen (Sandbox-Script)
```
[TOOL:skill_manage({
  "action": "execute",
  "name": "my-skill-with-script"
})]
```

**Wann nutzen:**
- Automatisierte Tasks durchführen
- Scripts die im Skill gespeichert sind ausführen
- Nur wenn Skill ein `script.js` enthält

### 5. Skill löschen
```
[TOOL:skill_manage({
  "action": "delete",
  "name": "obsolete-skill"
})]
```

**Wann nutzen:**
- Veraltete Skills entfernen
- Cleaner Code-Architektur aufrechterhalten
- VORSICHT: Löschen ist permanent!

## Skill-Struktur (Best Practice)

```markdown
# Skill: Descriptive Name

## Zusammenfassung
1-2 Sätze was dieser Skill macht und wofür er gut ist.

## Verwendungsbeispiele

### Use Case 1: [Concrete Task]
Code-Beispiel zeigen:
\`\`\`
[TOOL:relevant_tool(...)]
\`\`\`
Erklären was passiert.

## Best Practices
- Was zu vermeiden ist
- Gotchas/Fallstricke
- Performance-Tipps

## Abhängigkeiten
- Welche Tools/Skills sind nötig
- Voraussetzungen für Nutzung

## Siehe auch
- [andere-related-skills]
```

## Integrationsmuster

### Pattern 1: Tool-Skill-Kombination
Skills funktionieren am besten wenn sie:
1. Ein bestimmtes Tool dokumentieren (z.B. skill-manage selbst)
2. Spezifische Use-Cases zeigen
3. Mit Agent-Workflows zusammenpassen

### Pattern 2: Skill-Verkettung
Skills können andere Skills referenzieren:
- `[TOOL:skill_manage({"action": "view", "name": "filesystem-operations"})]`
- Hilft dem Agent beste Practices zu lernen
- Schafft zusammenhängende Wissensbasis

## Wichtige Regeln

⚠️ **KRITISCH:**
- Skills sind **JSON-safe**: Inhalt muss korrekt escaped sein
- Keine sensiblen Informationen in Skills speichern
- Skills sind PUBLIC - alle Agents können sie lesen
- Skill-Namen sollten kebab-case sein (my-skill-name)

✅ **EMPFOHLEN:**
- Kurze, fokussierte Skills (nicht > 2000 Zeichen)
- Praktische Beispiele statt nur Theorie
- Tool-Links einbauen: `[TOOL:tool_name(...)]`
- Zusammenhängende Skills als Ökosystem denken

## Workflow-Integration

Guter Workflow mit Skills:
1. **Ziel definieren** - Was muss ich tun?
2. **Relevante Skills finden** - `skill_manage list` + `skill_manage view`
3. **Best Practices lernen** - Von ähnlichen Skills
4. **Tool nutzen** - Mit Dokumentation aus Skill
5. **Ergebnis evaluieren** - Funktioniert es?
6. **Skill updaten?** - Falls neue Patterns gefunden wurden

## Häufige Fehler

❌ **Zu tun:**
- Skill-Namen zu lang oder mit Underscores
- Zu viel Text, zu wenig Struktur
- Tools ohne Erklärung nutzen
- Auf veraltete Skills verlassen

✅ **Stattdessen:**
- Kurze, aussagekräftige Namen
- Gliederung mit `## Überschriften`
- Immer Tool-Beispiele zeigen
- Skills regelmäßig updaten

## Selbst-Referenz

Dieser Skill dokumentiert das `skill_manage` Tool.
Man kann damit auch sich selbst updaten:

```
[TOOL:skill_manage({
  "action": "write",
  "name": "skill-manage",
  "content": "[neuer Skill-Text]"
})]
```

Nützlich um Best Practices zu etablieren, die alle Skills befolgen sollten.
