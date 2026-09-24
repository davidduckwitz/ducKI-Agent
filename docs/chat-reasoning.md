# Thinking / Reasoning in den Chats

Die Eingabeleisten für normalen Chat, Coding und Audio bieten `Aus`, `low`,
`medium`, `high` und `xhigh`. `Standard` lässt die Modellvorgabe unverändert.
Die Auswahl wird wie eine gemeinsame Chat-Präferenz verwendet und lokal im
Browser gespeichert. Sie gilt ab der nächsten Nachricht, nicht rückwirkend
für einen laufenden Auftrag.

## Anfragepfad

- Normal und Audio: `ChatComposer` → App-Store → `chat:message` → `Agent.run`.
- Coding: `CodingAgentPanel` → `CodingWorkspace` → `/coding-agent/run` →
  `CodingAgent.run`.
- HTTP-Chat: `/chat` übergibt die Einstellung auch an Reparaturversuche.

`reasoningEffort` wird an den HTTP-/WebSocket-Grenzen validiert. Ein
`AsyncLocalStorage`-Kontext bindet die Einstellung an den Lauf. Dadurch erhalten
auch Planung, Exploration, Kompression und Wiederholungen dieselbe Vorgabe,
ohne gemeinsam genutzte Provider-Instanzen zu verändern. Verschachtelte Läufe
ohne eigene Vorgabe erben die Einstellung; parallele Chats bleiben getrennt.

## Provider

| Provider | Übertragung |
| --- | --- |
| OpenAI | `reasoning_effort`, `Aus` als `none`; bei Reasoning-Modellen passende Token- und Sampling-Parameter |
| OpenRouter | `reasoning.effort` beziehungsweise `reasoning.enabled: false` |
| Ollama | `reasoning_effort`, auch im separaten Bild-/Streaming-Pfad |
| LM Studio | Bei expliziter Auswahl `/v1/responses` mit `reasoning.effort`; Standard behält `/chat/completions` |
| Claude | Adaptive Thinking für neuere Modelle, sonst gestaffeltes Thinking-Tokenbudget; `Aus` als `disabled` |

Die Modell- und Serverunterstützung bleibt maßgeblich: nicht jedes Modell kann
Thinking abschalten oder jede Stufe ausführen. Ablehnungen des Providers werden
als Fehler weitergegeben und nicht still durch eine andere Einstellung ersetzt.
Bei Claude 4.6 entspricht `xhigh` der dortigen Stufe `max`; ältere Claude-Modelle
erhalten Budgets von 1024/4096/8192/16384 Tokens. LM Studio benötigt für eine
explizite Auswahl einen Server mit Responses-Unterstützung.

Referenzen: [OpenAI](https://developers.openai.com/api/docs/guides/reasoning),
[OpenRouter](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
[Ollama](https://docs.ollama.com/api/openai-compatibility),
[LM Studio](https://lmstudio.ai/docs/developer/openai-compat/responses),
[Claude](https://platform.claude.com/docs/en/build-with-claude/effort).

Verifiziert durch Provider-Request-Tests (einschließlich Streaming, Bilder,
Tool-Aufrufe, Abbruch und parallele Kontexte), Coding-Regressionstests,
TypeScript-Prüfungen und Produktionsbuilds. Die UI-Auswahl wurde in allen drei
Modi und nach einem Neuladen geprüft. Keine kostenpflichtigen Live-Modellanfragen
wurden dafür ausgeführt.
