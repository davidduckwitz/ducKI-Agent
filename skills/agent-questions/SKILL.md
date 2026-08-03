---
name: agent-questions
description: "Enables structured question dialogs for agent-user interactions with multiple choice, text, and combined input modes"
version: 1.0.0
---

# Agent Question System Skill

## Zweck
Ermöglicht es dem Agent, Rückfragen an den Benutzer zu stellen mit verschiedenen Antworttypen (Multiple Choice, Text, Kombiniert). Diese Fragen werden in speziellen formattierten Boxen angezeigt.

## Anwendung

### Einfache Text-Frage
Wenn du eine offene Frage stellen möchtest:

```json
{
  "type": "question",
  "question": {
    "id": "unique-id",
    "question": "Was ist dein Name?",
    "description": "Gib deinen Namen ein für die Personalisierung",
    "type": "text",
    "placeholder": "z.B. Max Mustermann",
    "required": true
  }
}
```

### Multiple Choice Frage
Wenn der Benutzer zwischen vordefinierten Optionen wählen soll:

```json
{
  "type": "question",
  "question": {
    "id": "unique-id",
    "question": "Welche Programmiersprache bevorzugst du?",
    "type": "multiple-choice",
    "options": [
      {
        "id": "js",
        "label": "JavaScript/TypeScript",
        "description": "Web-Entwicklung und Node.js"
      },
      {
        "id": "py",
        "label": "Python",
        "description": "Data Science und Automation"
      },
      {
        "id": "go",
        "label": "Go",
        "description": "Backend und Systemtools"
      }
    ]
  }
}
```

### Kombinierte Frage (Choices + Custom Input)
Wenn Benutzer aus Optionen wählen ODER eigene Eingabe machen können:

```json
{
  "type": "question",
  "question": {
    "id": "unique-id",
    "question": "Welche Verbesserungen möchtest du am Plan?",
    "description": "Wähle eine Option oder gib deine eigene Idee ein",
    "type": "combined",
    "options": [
      {
        "id": "more-details",
        "label": "Mehr Details",
        "description": "Füge detaillierte Schritte hinzu"
      },
      {
        "id": "simplify",
        "label": "Vereinfachen",
        "description": "Reduziere Komplexität"
      },
      {
        "id": "add-error-handling",
        "label": "Fehlerbehandlung",
        "description": "Füge Error Handling hinzu"
      }
    ],
    "placeholder": "Oder eigene Idee eingeben...",
    "required": true
  }
}
```

## Antwort-Verarbeitung

Der Benutzer antwortet auf die Frage, und die Antwort wird dir zurückgegeben. Du kannst die Antwort dann verwenden, um deine nächsten Schritte zu gestalten.

### Beispiel-Workflow für Plan-Verbesserung:

1. **Du stellst eine Frage:**
```json
{
  "type": "question",
  "question": {
    "id": "plan-improvement",
    "question": "Welche Aspekte des Plans sollen verbessert werden?",
    "type": "combined",
    "options": [
      { "id": "clarity", "label": "Klarheit", "description": "Mache den Plan verständlicher" },
      { "id": "efficiency", "label": "Effizienz", "description": "Reduziere Anzahl der Schritte" },
      { "id": "robustness", "label": "Robustheit", "description": "Füge Fehlerbehandlung hinzu" }
    ],
    "placeholder": "Oder anderer Verbesserungsvorschlag...",
    "required": true
  }
}
```

2. **Der Benutzer antwortet** (entweder Wahl oder Custom-Text)

3. **Du erhältst die Antwort** und verarbeitest sie:
   - Wenn Option: `{ "option": "clarity", "custom": "" }`
   - Wenn Custom: `{ "option": "", "custom": "Mach den Plan kürzer" }`
   - Wenn Beide: `{ "option": "clarity", "custom": "und noch spezifischer" }`

4. **Du überarbeitest den Plan** basierend auf der Antwort

5. **Du fragst erneut**, ob weitere Verbesserungen gewünscht sind

## Best Practices

### ✅ Gute Fragen
- Präzise und eindeutig formuliert
- Mit hilfreichen Optionen, die reale Entscheidungen abbilden
- Mit Fallback (Custom Input) für Benutzer-Ideen
- Mit aussagekräftigen Descriptions für jede Option

### ❌ Schlechte Fragen
- Zu offen oder mehrdeutig
- Zu viele Optionen (max. 4-5 empfohlen)
- Keine Option für Benutzer-Input bei Multiple Choice
- Fehlende Beschreibungen für Optionen

## Integration mit anderen Komponenten

Diese Fragen werden nahtlos in den Chat-Fluss integriert:
- Sie erscheinen als formatierte Boxen mit blauer Färbung
- Der Benutzer kann direkt in der Box antworten
- Nach der Antwort wird die Box grün gefärbt
- Deine Folge-Aktion wird direkt in den Chat geschrieben

## Beispiel: Iterativer Plan-Verbesserungs-Prozess

```
1. Agent zeigt aktuellen Plan
2. Agent stellt Frage: "Was soll verbessert werden?"
   [Multiple Choice Box mit Optionen + Custom Input]
3. Benutzer antwortet
4. Agent: "Verstanden! Ich überarbeite den Plan mit Fokus auf [Antwort]..."
5. Agent zeigt verbesserten Plan
6. Agent fragt: "Möchtest du weitere Verbesserungen?"
   [Ja / Nein / Eigene Idee]
7. Falls ja: zurück zu Schritt 2
8. Falls nein: "Perfekt! Plan ist bereit zur Umsetzung."
```

## Technische Details

- Frage-ID muss eindeutig sein (für Tracking)
- `required: true` bedeutet, dass mindestens ein Feld gefüllt sein muss
- Kombinierte Fragen erlauben Wahl ODER Custom-Input oder BEIDE
- Questions sind asynchron - der Agent wartet auf die Antwort des Benutzers

## Verwendungsbeispiele

### Plan-Verbesserung (bereits implementiert)
Agent fragt nach Verbesserungen und überarbeitet den Plan iterativ.

### Feature-Klärung
Agent fragt, welche Features priorisiert werden sollen.

### Konfiguration
Agent fragt nach Benutzer-Präferenzen (z.B. Programmiersprache, Framework).

### Fehlerbehandlung
Agent fragt, wie mit Fehlern umgegangen werden soll.

### Code-Review-Entscheidungen
Agent fragt nach Code-Style-Präferenzen.
