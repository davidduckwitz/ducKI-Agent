---
name: coding-system
description: "Nutze den Coding-Bereich fuer AI/Vibe Coding mit projektgebundenem Chat und Datei-Editor im shared-workspace/coding."
related_skills: [shared-workspace-ops, browser-control, test-driven-development, code-review, security-skill]
primary_skills: [shared-workspace-ops, test-driven-development, code-review, security-skill]
fallback_skills: [shared-workspace-api-first, code-review, workflow-orchestrator, security-skill]
version: 1.0.0
---

# Coding System Skill

## Ziel
Nutze den integrierten Coding-Bereich fuer projektbezogenes Arbeiten mit Chat + Editor, statt unstrukturierter Einzeldatei-Operationen.

## Wann nutzen
- Wenn der Nutzer an Features/Code innerhalb eines dedizierten Coding-Projekts arbeiten will.
- Wenn AI/Vibe Coding mit paralleler Dateibearbeitung verlangt ist.
- Wenn die Arbeit sauber in `shared-workspace/coding/<project>` abgelegt werden soll.

## Harte Regeln
1. Pruefe zuerst, ob `CODING_ENABLED=true` gesetzt ist.
2. Nutze Coding-Projekte als Arbeitskontext; keine Vermischung mit fremden Shared-Pfaden.
3. Speichere Dateien nur unter `shared-workspace/coding/<project>/...`.
4. Bei grossen Aenderungen zuerst TDD- oder Plan-Schritte ausfuehren.

## Schreibdisziplin (verpflichtend)
1. Nutze fuer Coding-Dateien nur relative Pfade innerhalb des aktuellen Projekts.
2. Bei Filesystem-Operationen immer setzen:
- `basePath: "./shared-workspace/coding/<project>"`
- `safeMode: true`
- `createDirs: true` (bei write/append)
3. Vor jedem `write`/`append`/`move`/`copy` zuerst mit `dryRun: true` validieren.
4. Nach jeder Schreiboperation sofort verifizieren:
- `exists` oder `stat` auf Zieldatei
- optional `read` fuer Inhaltskontrolle bei Textdateien
5. Keine absoluten Pfade verwenden.
6. Bei Pfad- oder Scope-Fehlern sofort abbrechen und den Pfad auf das Projekt-Root zurueckfuehren.

## Minimales Dateischreib-Muster
1. Zielpfad bestimmen: relativ zu `shared-workspace/coding/<project>`.
2. Dry-Run ausfuehren (`dryRun: true`).
3. Write ausfuehren (`dryRun: false`).
4. Ergebnis verifizieren (`exists`/`stat`/`read`).

## API-Flow
1. `GET /api/coding/status`
2. `GET /api/coding/projects`
3. Falls noetig `POST /api/coding/projects`
4. Danach Dateioperationen nur unter `/api/coding/projects/:project/*`

## Chat-Flow
- Pro Coding-Projekt eigenen Konversationskontext verwenden.
- Prompt immer mit Projekt- und Workspace-Hinweis senden:
- `workspaceRoot=shared-workspace/coding/<project>`

## Skill Interop
- `shared-workspace-ops`: persistente Dateioperationen und Strukturpflege.
- `shared-workspace-api-first`: wenn API-Paritaet strikt erzwungen werden muss.
- `test-driven-development`: bei Feature-Implementierungen mit Tests.
- `code-review`: Abschlusspruefung vor finaler Uebergabe.
- `workflow-orchestrator`: fuer mehrstufige Coding-Pipelines.

## Ergebnisformat
1. Projektname und Zielpfad
2. Geaenderte Dateien
3. Chat-/Implementierungsfortschritt
4. Offene Punkte oder naechster Schritt
