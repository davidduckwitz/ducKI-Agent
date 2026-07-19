# Security Quick Checklist (1 Minute)

Nutze diese Kurzversion bei Low-Risk-Tasks ohne sensible Daten oder kritische Infrastruktur.

## 1. Scope in einem Satz
- Was wird konkret geaendert?
- Was bleibt garantiert unberuehrt?

## 2. Kein Secret-Risiko
- Keine Tokens, Keys, Passwoerter oder vertrauliche Inhalte ausgeben, loggen oder committen.

## 3. Kein destruktiver Schritt
- Keine potenziell gefaehrlichen Befehle ohne explizite Freigabe.
- Bei Unsicherheit stoppen und nachfragen.

## 4. Trust-Check
- Externe Eingaben nicht blind uebernehmen.
- Mindestens einfache Validierung/Sanitizing anwenden.

## 5. Mini-Verifikation
- Einen konkreten Check ausfuehren (z. B. typecheck/test/repro) und Ergebnis benennen.
