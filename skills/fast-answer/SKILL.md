---
name: fast-answer
description: "Check if no Skill is needed for fast answers"
related_skills: [datum-uhrzeit-tag, llm-wiki, history-search, browser-control, plan]
primary_skills: [datum-uhrzeit-tag, llm-wiki]
fallback_skills: [history-search, browser-control, plan]
version: 1.0.0
---

# Fast Answer

## Zweck
Pruefe, ob eine direkte Antwort ohne komplexe Skill-Kette moeglich ist.

## Entscheidung
1. Wenn die Frage mit vorhandenem Kontext sofort sicher beantwortbar ist: direkt antworten.
2. Wenn ein Spezialfall erkannt wird, an den passenden Skill delegieren.
3. Wenn die Aufgabe umfangreich ist, `plan` oder `workflow-orchestrator` aktivieren.

## Skill Interop

- Zeit-/Datum-Fragen immer an `datum-uhrzeit-tag` delegieren.
- Wissens-/Doku-Fragen bevorzugt ueber `llm-wiki` und optional `history-search` absichern.
- Browser-/UI-Aufgaben an `browser-control` delegieren; Dateiablage dabei ueber `shared-workspace-ops`.
- Review-/Qualitaetsfragen an `code-review`, Implementierungslaeufe an `test-driven-development` delegieren.



