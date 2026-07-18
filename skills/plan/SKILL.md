---
name: plan
description: "Planning mode: actionable plan only, no direct implementation in this turn."
related_skills: [fast-answer, history-search, llm-wiki, test-driven-development, code-review, workflow-orchestrator]

primary_skills: [history-search, llm-wiki]
fallback_skills: [test-driven-development, code-review]
version: 1.0.0
source: "Inspired by https://github.com/NousResearch/hermes-agent/blob/main/skills/software-development/plan/SKILL.md"
---

# Plan Mode

## Zweck
Nutze diesen Skill, wenn der User einen belastbaren Umsetzungsplan erwartet und nicht sofort Implementierung.

## Regeln
- Keine produktiven Codeaenderungen in diesem Schritt.
- Falls noetig nur read-only Repo-Inspektion.
- Ergebnis ist ein konkreter, testbarer Schritt-fuer-Schritt-Plan.

## Plan-Struktur
1. Ziel und Scope.
2. Aktueller Stand und Annahmen.
3. Schrittfolge in kleinen Tasks.
4. Betroffene Dateien und Schnittstellen.
5. Test- und Verifikationsstrategie.
6. Risiken und offene Fragen.

## Qualitaetskriterien
- Jeder Task ist klein und eindeutig.
- Dateipfade und Kommandos sind konkret.
- Akzeptanzkriterien sind messbar.

## Skill Interop

- Vor Plan-Erstellung mit `fast-answer` pruefen, ob die Anfrage ohne Plan geloest werden kann.
- Historische Loesungen ueber `history-search` in Annahmen/Risiken einbeziehen.
- Bei Wissens-/Doku-Anteilen `llm-wiki` als Quelle im Plan nennen.
- Fuer Implementierungsphasen `test-driven-development` und fuer Abnahme `code-review` als nachgelagerte Schritte einplanen.


