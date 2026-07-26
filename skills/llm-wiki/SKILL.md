---
name: llm-wiki
description: "Nutze das LLM-Wiki als primaere Wissensquelle, mit klarer Reihenfolge fuer Search, Moderation und Antwortaufbau."
related_skills: [shared-workspace-ops, cronjobs, history-search, workflow-orchestrator]

primary_skills: [shared-workspace-ops]
fallback_skills: [history-search, workflow-orchestrator]
version: 1.0.0
---

# LLM Wiki Skill

## Ziel
Verwende das LLM-Wiki korrekt, bevor externe oder unzuverlaessige Quellen genutzt werden.

## Wann anwenden
Nutze diesen Skill bei Fragen nach vorhandenem Wissen, internen Dokumenten, wiederkehrenden Fakten, Regeln, Projektkonventionen oder wenn der User explizit nach Wiki/Knowledge fragt.

## Ausfuehrungsreihenfolge
1. Suche mit dem `wiki`-Tool: `wiki action=search query="..."`.
2. Formuliere die Suche als Stichworte, nicht als ganzen Satz - gesucht wird ueber Begriffe.
3. Wenn nichts passt: einmal mit anderen/breiteren Begriffen erneut suchen, bevor du aufgibst.
4. Fuer den Volltext eines Treffers: `wiki action=get id=<id>`.
5. Nutze bevorzugt `approved` Eintraege; `candidate` nur mit `includeCandidates=true` und Kennzeichnung als vorlaeufig.
6. Wenn keine Treffer vorhanden sind, sage das explizit - erfinde keine Wiki-Inhalte.

## Tool-Nutzung
- Primaer: das native `wiki`-Tool (`action=search|get|status`). Es laeuft im selben Prozess,
  es sind keine URLs, Ports oder HTTP-Aufrufe noetig.
- Nur fuer Moderation (approve/reject) das HTTP-Tool gegen `/api/wiki/entries/:id/approve`
  bzw. `.../reject` nutzen, und ausschliesslich bei explizitem Review-Auftrag.

## Antwortregeln
- Nenne bei Fakten die Quelle (`sourcePath`/Titel) kurz mit.
- Bei mehreren Treffern: priorisiere hoechsten Score + neuere Eintraege.
- Trenne sicheres Wissen (approved) von vorlaeufigem Wissen (candidate).

## Guardrails
- Kein Halluzinieren bei fehlenden Treffern.
- Keine stillschweigende Nutzung von `candidate` als harte Wahrheit.
- Wenn Wiki deaktiviert ist, weise darauf hin und arbeite mit alternativen Quellen weiter.

## Skill Interop

- Wenn relevantes Wissen fehlt, neue/aktualisierte Inhalte ueber `shared-workspace-ops` in `shared-workspace/llm-wiki` ablegen.
- Fuer periodisches Lernen/Reindexing `cronjobs` einsetzen.
- Bei Antwortkonflikten zwischen Wiki und Historie `history-search` als Gegencheck nutzen.
- Fuer laengere Wissens-Pipelines `workflow-orchestrator` verwenden.


