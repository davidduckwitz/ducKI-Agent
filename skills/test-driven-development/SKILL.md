---
name: test-driven-development
description: "TDD-first implementation: red, green, refactor with explicit verification."
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
