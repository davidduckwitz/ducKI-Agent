# Security Checklist

Nutze diese Kurz-Checkliste bei allen riskanten Aenderungen als Pflichtablauf.

## 1. Scope
- Was ist exakt im Scope?
- Welche Systeme/Dateien sind explizit out-of-scope?

## 2. Secrets
- Werden Tokens, Keys, Passwoerter oder sensible Inhalte verarbeitet?
- Sicherstellen: keine Ausgabe in Logs, Chat-Antworten oder Commits.

## 3. Input/Trust
- Kommen Daten aus externer oder untrusted Quelle?
- Validierung/Sanitizing vorhanden und ausreichend streng?

## 4. Auth/Policy
- Aendert die Aufgabe Auth, Rollen, Signaturen, Sessions oder CORS?
- Gibt es eine moegliche Privileg-Eskalation?

## 5. Execution Risk
- Enthalten Shell/Tool-Schritte destruktive oder weitreichende Befehle?
- Gibt es einen sicheren Dry-Run oder einen kleineren Testschritt vor Full-Run?

## 6. Data Safety
- Koennen Daten verloren gehen, ueberschrieben oder exfiltriert werden?
- Backup/Rollback klar definiert?

## 7. Gateway/Discord
- Bei Outbound: zuerst Gateway-Konfiguration pruefen (`list_configs`).
- Kein Versand sensibler Daten bei unklarem Ziel.

## 8. Verification
- Welche konkreten Checks belegen den Security-Fix (typecheck/tests/repro)?
- Wurden nur die benoetigten Aenderungen gemacht?

## 9. Incident Mode
- Bei Verdacht auf Sicherheitsproblem: sofort stoppen.
- Risiko, Auswirkung, Dringlichkeit und naechsten sicheren Schritt melden.

## 10. Abschluss
- Rest-Risiko benennen.
- Empfohlenen naechsten Schritt dokumentieren.
