# Agent Question System - Implementation Guide

## Übersicht
Ein professionelles System für den Agent, um Rückfragen mit verschiedenen Antworttypen zu stellen. Fragen werden in speziellen Boxen dargestellt und der Agent erhält die Antworten strukturiert zurück.

## Komponenten

### 1. AgentQuestionBox (`apps/web/src/components/chat/AgentQuestionBox.tsx`)
**Wiederverwendbare React-Komponente für die Darstellung von Fragen**

```typescript
interface AgentQuestion {
  id: string;
  question: string;
  description?: string;
  type: "multiple-choice" | "text" | "combined";
  options?: QuestionOption[]; // für multiple-choice und combined
  placeholder?: string;
  required?: boolean;
}

interface AgentQuestionBoxProps {
  question: AgentQuestion;
  onAnswer: (answer: string | { option: string; custom?: string }) => void;
  isLoading?: boolean;
}
```

**Features:**
- ✅ Multiple Choice mit Descriptions
- ✅ Text-Input mit Eingabefeld
- ✅ Kombiniert (Choices + Custom Input)
- ✅ Loading-State während Verarbeitung
- ✅ Validierung (required)
- ✅ Enter-Taste zum Absenden (Text/Combined)
- ✅ Erfolgs-Feedback nach Antwort

**Styling:**
- Blauer Hintergrund für aktive Fragen
- Grüner Hintergrund nach Antwort
- Responsive und dark-mode aware

### 2. Agent Skill (`~/DucKI/shared-workspace/skills/agent-questions.md`)
**Anweisungen für den Agent, wie das Question System genutzt wird**

Enthält:
- JSON-Format-Spezifikationen für alle Fragetypen
- Best Practices
- Beispiel-Workflows
- Integrationshinweise

## Integration im Chat

### Wie der Agent Fragen stellt

Der Agent kann Fragen direkt im Chat stellen:

```markdown
Ich habe ein paar Fragen, um den Plan besser anpassen zu können:

## Verbesserungswünsche

```json
{
  "type": "question",
  "question": {
    "id": "plan-improvement-001",
    "question": "Welche Aspekte sollen verbessert werden?",
    "type": "combined",
    "options": [
      {
        "id": "clarity",
        "label": "Klarheit",
        "description": "Mache Schritte verständlicher"
      },
      {
        "id": "efficiency",
        "label": "Effizienz",
        "description": "Reduziere Komplexität"
      }
    ],
    "placeholder": "Oder eigener Verbesserungswunsch...",
    "required": true
  }
}
```

Nach Benutzer-Antwort erhält der Agent die Antwort und verarbeitet sie.
```

### Chat-Integration (noch zu implementieren)

Die ChatContainer Komponente muss aktualisiert werden, um:
1. Frage-JSON im Agent-Response zu erkennen
2. AgentQuestionBox zu rendern
3. Antworten zurück an den Agent zu senden

**Beispiel-Integration:**
```typescript
// In ChatContainer oder RenderedChatMessage
if (msg.eventData?.type === "question") {
  return (
    <AgentQuestionBox
      question={msg.eventData.question}
      onAnswer={(answer) => {
        // Sende Antwort zurück an Agent
        api.chat.sendMessage(conversationId, {
          role: "user",
          content: `Meine Antwort: ${JSON.stringify(answer)}`
        });
      }}
    />
  );
}
```

## Verwendungsszenarien

### 1. Plan-Verbesserung
**Workflow:**
1. Agent zeigt aktuellen Plan
2. Agent fragt: "Welche Aspekte sollen verbessert werden?"
3. Benutzer wählt Option oder gibt Custom-Input
4. Agent überarbeitet Plan basierend auf Antwort
5. Agent fragt: "Weitere Verbesserungen?"
6. Iteratives Feedback bis Benutzer zufrieden

### 2. Feature-Priorisierung
**Workflow:**
1. Agent hat mehrere Feature-Ideen
2. Agent fragt: "Welche Features sind wichtigsten?"
3. Benutzer wählt aus Liste oder definiert Prioritäten
4. Agent passt Plan zu Prioritäten an

### 3. Technologie-Auswahl
**Workflow:**
1. Agent braucht Entscheidung über Framework/Tool
2. Agent fragt: "Welches Framework bevorzugst du?"
3. Benutzer wählt (React, Vue, Angular, etc.)
4. Agent passt technische Lösung an

### 4. Konfiguration/Einstellungen
**Workflow:**
1. Agent braucht Benutzer-Präferenzen
2. Agent fragt: "Code-Style: Tabs oder Spaces?"
3. Benutzer wählt Präferenz
4. Agent generiert Code mit gewähltem Style

## JSON-Format im Chat

Der Agent kann Fragen im Chat als Code-Block einfügen:

```markdown
# Meine Frage an dich

\`\`\`json
{
  "type": "question",
  "question": {
    "id": "unique-id",
    "question": "Deine Frage hier?",
    "type": "multiple-choice",
    "options": [...]
  }
}
\`\`\`
```

Die Chat-Komponente erkennt diese JSON-Blöcke und rendered AgentQuestionBox statt Code-Block.

## Antwort-Format

**Beispiel-Antworten:**

Multiple Choice:
```
Meine Antwort: "js" (die option ID)
```

Text Input:
```
Meine Antwort: "Mein Custom-Text hier"
```

Combined:
```
Meine Antwort: {"option": "clarity", "custom": "und noch spezifischer"}
```

## Nächste Schritte zur vollständigen Integration

1. **Chat-Komponente aktualisieren**
   - `apps/web/src/components/chat/ChatContainer.tsx`
   - JSON-Frage-Erkennung hinzufügen
   - AgentQuestionBox rendern für Fragen

2. **Message-Typen erweitern**
   - `apps/web/src/components/chat/chatTypes.ts`
   - `question` Event-Type hinzufügen

3. **Agent-Prompt aktualisieren**
   - Anweisungen hinzufügen, dass Agent Fragen im JSON-Format stellen kann
   - Link zum Skill `agent-questions.md` im System-Prompt

4. **Testing**
   - Komponenten-Tests für AgentQuestionBox
   - Integration-Test mit echter Agent-Antwort

## Vorteile

✅ **Bessere Benutzer-Interaktion:** Strukturierte Fragen statt freier Text  
✅ **Höhere Qualität:** Agent kann basierend auf präzisen Antworten arbeiten  
✅ **Wiederverwendbar:** Komponente für alle Agent-Fragen nutzbar  
✅ **Professionell:** Angepasst an Agent-Workflows  
✅ **Iterativ:** Ermöglicht Feedback-Schleifen für Verbesserungen  
✅ **Flexibel:** Multiple Choice, Text, oder kombiniert möglich  

## Code-Beispiel: Kompletter Workflow

```typescript
// Agent stellt Frage
const question: AgentQuestion = {
  id: "plan-improve-001",
  question: "Was soll am Plan verbessert werden?",
  description: "Wähle eine Option oder gib deine Idee ein",
  type: "combined",
  options: [
    { id: "clarity", label: "Klarheit", description: "Verständlichkeit" },
    { id: "efficiency", label: "Effizienz", description: "Weniger Schritte" },
    { id: "robustness", label: "Robustheit", description: "Error Handling" }
  ],
  placeholder: "Andere Verbesserungsidee...",
  required: true
};

// Benutzer antwortet
const answer = { option: "clarity", custom: "" };

// Agent verarbeitet Antwort
if (answer.option === "clarity") {
  // Überarbeite Plan für bessere Klarheit
}

// Agent fragt Folgeaction
// "Weitere Verbesserungen? (Ja/Nein)"
```

---

**Status:** ✅ Komponente erstellt und dokumentiert  
**Nächst:** Chat-Integration in ChatContainer.tsx  
**Dann:** Agent-Prompt mit Skill-Link aktualisieren
