---
name: tasks-kanban
description: "Steuert Task- und Kanban-Ablaeufe robust: korrekt anlegen, in running setzen, sauber abschliessen oder failen."
related_skills: [plan, code-review, test-driven-development, history-search]

primary_skills: [plan]
fallback_skills: [code-review, history-search]
version: 1.0.0
---

# Tasks / Kanban Bedienung

## Zweck
Nutze diesen Skill fuer alle Arbeiten, bei denen Tasks im Kanban-Board erstellt, bearbeitet, gestartet, abgeschlossen oder fehlgeschlagen markiert werden muessen.

## Tool Contract
Nutze Tool `task` mit diesen Actions:
- `create`
- `list`
- `get`
- `update`
- `start`
- `complete`
- `fail`
- `delete`

Unterstuetzte Statuswerte:
- `pending`
- `running`
- `completed`
- `failed`
- `cancelled`

## Kernregeln
1. Wenn Arbeit laenger als eine direkte Ein-Satz-Antwort dauert, existiert ein Task.
2. Bevor du eine Umsetzung startest: Task auf `running` setzen (`task:start`).
3. Nach erfolgreicher Umsetzung und Verifikation: Task auf `completed` setzen (`task:complete`).
4. Bei blockierendem Fehler: Task auf `failed` setzen (`task:fail`) und Fehlergrund klar benennen.
5. Lass niemals einen Task unbegruendet in `running` stehen.
6. Nutze keine freien Status-Strings ausser den erlaubten Werten.

## Standard-Ablauf
1. **Pruefen/finden**
- Wenn Task-ID bekannt: `task:get`.
- Wenn nicht klar: `task:list` und passenden Task identifizieren.

2. **Anlegen (falls noetig)**
- Mit `task:create` anlegen, inkl. klarer `title` und kurzer `description`.
- Falls Kontext bekannt, `projectId` setzen.
- Initialstatus ist `pending`.

3. **Starten**
- Direkt vor aktiver Arbeit: `task:start`.
- Bei mehreren Teilaufgaben zuerst Plan erstellen, dann starten.

4. **Bearbeiten/fortschreiben**
- Mit `task:update` Titel/Beschreibung/Prioritaet/Status nur gezielt anpassen.
- Status nur dann manuell via `update` setzen, wenn `start/complete/fail` semantisch nicht passt.

5. **Abschluss**
- Nur `task:complete`, wenn Definition of Done erreicht ist:
- Implementierung fertig
- relevante Checks ausgefuehrt (z. B. typecheck/tests/lint)
- bekannte Blocker dokumentiert oder behoben

6. **Fehlerfall**
- Wenn Arbeit technisch blockiert oder reproduzierbar scheitert:
- `task:fail`
- Grund + naechster sinnvoller Schritt nennen

## Entscheidungsmatrix fuer Abschluss
- `completed`:
- Ergebnis erreicht und verifiziert.

- `failed`:
- Ziel aktuell nicht erreichbar (z. B. harter Build-Fehler, fehlende Credentials, externe Abhaengigkeit down).

- `pending`:
- Aufgabe ist eingeplant, aber noch nicht gestartet.

- `running`:
- Aufgabe wird aktiv bearbeitet.

- `cancelled`:
- Nur verwenden, wenn Nutzer oder Prozess den Task explizit verwirft.

## Guardrails
- Keine stillen Task-Wechsel ohne Rueckmeldung.
- Keine Loeschung (`delete`) ohne klaren Grund.
- Bei Unsicherheit lieber `task:update` mit praeziser Beschreibung als falsches `complete`.
- Nach `fail` nie sofort `complete`, ohne neue erfolgreiche Ausfuehrung.

## Empfohlenes Antwortformat an den Nutzer
1. Task-ID und aktueller Status
2. Was ausgefuehrt wurde
3. Ergebnis (inkl. Verifikation)
4. Naechster Schritt oder Abschlussgrund

## Skill Interop
- Nutze `plan`, wenn Scope oder Reihenfolge unklar ist.
- Nutze `test-driven-development` fuer saubere Verifikation vor `complete`.
- Nutze `code-review` fuer Abschlusskontrolle bei riskanten Aenderungen.
- Nutze `history-search`, um bestehende Task-Muster wiederzuverwenden.
