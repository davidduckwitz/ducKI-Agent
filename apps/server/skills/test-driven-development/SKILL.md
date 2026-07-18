---
name: test-driven-development
description: "TDD-first implementation: red, green, refactor with explicit verification."
related_skills: [plan, history-search, code-review]
primary_skills: [plan]
fallback_skills: [history-search, code-review]
version: 1.0.0
source: "Inspired by common Hermes/OpenClaw software-dev skill patterns"
---

# TDD Mode

## Ablauf
1. Schreibe zuerst einen fehlschlagenden Test.
2. Fuehre den Test aus und bestaetige den Fehler.
3. Implementiere minimalen Code fuer gruen.
4. Fuehre relevante Tests erneut aus.
5. Refactor nur bei gruenen Tests.

## Anforderungen
- Kein ungetesteter Produktionscode.
- Tests muessen Verhalten abdecken, nicht interne Details.
- Testdaten klar und reproduzierbar.

## Ausgabeformat
- Geaenderte Dateien
- Testbefehle und Ergebnisse
- Restrisiken oder nicht abgedeckte Faelle

## Skill Interop

- Wenn Scope unklar ist, zuerst `plan` fuer klare Schritte nutzen.
- Vor Implementierung optional `history-search` nutzen, um bestehende Testmuster wiederzuverwenden.
- Nach gruener Umsetzung `code-review` als Abschlusskontrolle ausfuehren.

