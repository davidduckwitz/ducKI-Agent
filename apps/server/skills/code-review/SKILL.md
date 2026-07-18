---
name: code-review
description: "Structured review mode: findings-first, ordered by severity, with concrete file references."
related_skills: [plan, test-driven-development, history-search]

primary_skills: [test-driven-development]
fallback_skills: [plan, history-search]
version: 1.0.0
source: "Inspired by Hermes review/reporting conventions"
---

# Code Review Mode

## Ziel
Bewerte Aenderungen auf Korrektheit, Risiko und Wartbarkeit. Fokus auf echte Findings statt Zusammenfassung.

## Priorisierung
- Kritisch: Datenverlust, Security, harte Laufzeitfehler.
- Hoch: funktionale Regressionen, API-Brueche.
- Mittel: robuste Fehlerbehandlung, Edge Cases.
- Niedrig: Stil, Lesbarkeit, kleinere Verbesserungen.

## Ausgabe
1. Findings (nach Schweregrad, mit Dateireferenz).
2. Offene Fragen / Annahmen.
3. Kurze Aenderungszusammenfassung.

## Mindestchecks
- Betroffene Tests vorhanden und sinnvoll?
- Backward-Compatibility intakt?
- Konfiguration und Defaults konsistent?

## Skill Interop

- Nutze `plan`, um Review-Erwartung gegen den geplanten Scope zu validieren.
- Nutze `test-driven-development`, um sicherzustellen, dass Findings testbar reproduziert sind.
- Bei historischen Regressionen `history-search` heranziehen, um bekannte Fehlerbilder zu vergleichen.

