---
name: llm-wiki
description: "Nutze das LLM-Wiki als primaere Wissensquelle, mit klarer Reihenfolge fuer Search, Moderation und Antwortaufbau."
version: 1.0.0
---

# LLM Wiki Skill

## Ziel
Verwende das LLM-Wiki korrekt, bevor externe oder unzuverlaessige Quellen genutzt werden.

## Wann anwenden
Nutze diesen Skill bei Fragen nach vorhandenem Wissen, internen Dokumenten, wiederkehrenden Fakten, Regeln, Projektkonventionen oder wenn der User explizit nach Wiki/Knowledge fragt.

## Ausfuehrungsreihenfolge
1. Pruefe, ob das Wiki aktiv ist (`GET /api/wiki/status`).
2. Suche nach relevanten Eintraegen (`GET /api/wiki/search?query=...`).
3. Nutze bevorzugt `approved` Eintraege.
4. Nutze `candidate` nur mit Kennzeichnung als vorlaeufig.
5. Ignoriere `rejected` und `error`.
6. Wenn keine Treffer vorhanden sind, kommuniziere dies transparent.

## Tool-Nutzung
Wenn HTTP-Tool verfuegbar ist:
- Nutze lokale API-Endpunkte unter `/api/wiki/...`.
- Fuer Suche: `/api/wiki/search` mit `query` und optional `includeCandidates`.
- Fuer Moderation: `POST /api/wiki/entries/:id/approve` oder `.../reject` nur bei explizitem Korrektur- oder Review-Flow.

## Antwortregeln
- Nenne bei Fakten die Quelle (`sourcePath`/Titel) kurz mit.
- Bei mehreren Treffern: priorisiere hoechsten Score + neuere Eintraege.
- Trenne sicheres Wissen (approved) von vorlaeufigem Wissen (candidate).

## Guardrails
- Kein Halluzinieren bei fehlenden Treffern.
- Keine stillschweigende Nutzung von `candidate` als harte Wahrheit.
- Wenn Wiki deaktiviert ist, weise darauf hin und arbeite mit alternativen Quellen weiter.
