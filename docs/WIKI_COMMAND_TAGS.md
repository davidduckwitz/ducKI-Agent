# Wiki "Befehl"/"command" Tags

Wiki-Notizen mit dem Tag `befehl` (oder `command`) werden nicht wie normales Wissen behandelt,
sondern als **garantiert präsente Anweisung** an den Agenten — unabhängig davon, ob du sie per
Text oder per Sprache ansprichst.

## Warum das nötig ist

Normale Wiki-Inhalte werden beim Einlesen zu `semantic`-Memories. Die konkurrieren mit allen
anderen Erinnerungen um einen begrenzten Platz im Kontext (Top-8-Wichtigkeits-Auswahl in
`buildSystemContext`, siehe `packages/agent/src/memory/memory.ts`). Für eine Wissens-Notiz ist
das völlig ausreichend — für eine Anweisung wie "wenn ich 'Nachtmodus' sage, schalte alle
Lichter aus" nicht: sie müsste jedes Mal aufs Neue gegen alles andere gewinnen, um überhaupt
gesehen zu werden.

Es gibt bereits einen stärkeren Mechanismus dafür: die "Profile"-Einträge
(`[PROFILE:AGENT_BEHAVIOR]`/`[PROFILE:HUMAN_INFO]`, Importance 9), die praktisch immer im
Kontext landen. Der `befehl`-Tag hebt eine einzelne Wiki-Notiz in genau diesen Mechanismus.

## Verwendung

In der Frontmatter der Notiz:

```markdown
---
tags: [befehl]
---
Wenn ich "Nachtmodus" sage, schalte alle Lichter aus und aktiviere die
Fernseher-Stummschaltung.
```

Beim nächsten Ingest-Zyklus (automatisch alle 60s, oder manuell per Reindex-Button) wird daraus
ein `long-term`-Memory-Eintrag `[PROFILE:COMMAND:<Dateipfad>]` mit Importance 9 — dieser Eintrag
ist ab dann bei praktisch jedem Gesprächsbeginn im Kontext des Agenten vorhanden, egal worüber
gerade gesprochen wird.

Die englische Form `tags: [command]` funktioniert identisch.

## Verhalten

- **Bearbeiten**: Änderungen am Notiz-Inhalt aktualisieren den bestehenden Eintrag beim nächsten
  Ingest — kein Duplikat.
- **Tag entfernen**: Der Eintrag wird beim nächsten Ingest wieder entfernt.
- **Datei löschen**: Der Eintrag wird ebenfalls automatisch entfernt (Teil des bestehenden
  Prune-on-Delete-Mechanismus).

Nichts davon bleibt also dauerhaft "hängen", wenn du eine Notiz änderst oder löschst.

## Funktioniert das auch bei gesprochener Eingabe?

Ja, ohne Einschränkung. Alle drei Sprach-Eingabewege dieses Projekts — Web-Mikrofon
(`/api/chat/transcribe`), Discord-Sprachnachrichten, und die Cloud-Voice-App — transkribieren
Audio zu Text über dieselbe zentrale Funktion (`transcribeAudioBuffer()`,
`apps/server/src/lib/audio-transcription.ts`) und übergeben den Text danach an **exakt denselben**
`Agent.run()`-Pfad wie getippter Chat. Die Memory-Injektion (die auch die `[PROFILE:COMMAND:...]`-
Einträge einspielt) sitzt direkt in `Agent.run()` selbst — kein Sprachpfad umgeht sie.

Die einzige realistische Fehlerquelle ist also nicht die Architektur, sondern eine
**Fehltranskription** der Trigger-Phrase durch die Spracherkennung selbst (z. B. wenn "Nachtmodus"
falsch verstanden wird). Formuliere Trigger-Phrasen entsprechend robust/eindeutig.

## Empfehlungen

- Halte Befehls-Notizen kurz und konkret (Trigger-Phrase + gewünschte Aktion) — es ist eine
  Anweisung, die bei jedem Turn mitgeschickt wird, kein Ort für längere Referenz-Inhalte.
- Nutze eindeutige, unverwechselbare Trigger-Phrasen (kein alltägliches Wort), damit sie nicht
  versehentlich in normalen Sätzen ausgelöst werden.
- Mehrere Befehle sind problemlos möglich — jede getaggte Notiz bekommt ihren eigenen,
  unabhängig adressierten Eintrag.

## Verifikation

1. Notiz mit `tags: [befehl]` im Wiki-Ordner anlegen (oder eine bestehende taggen).
2. Reindex auslösen (UI-Button oder automatisch nach ≤60s).
3. Prüfen, dass der Eintrag existiert: `GET /api/memory?type=long-term` und nach
   `[PROFILE:COMMAND:...]` suchen, oder direkt in der SQLite-`memories`-Tabelle.
4. Im Chat (oder per Sprache) die Trigger-Phrase verwenden und beobachten, ob der Agent
   entsprechend reagiert.
5. Tag entfernen oder Datei löschen, erneut reindexen, bestätigen dass der Eintrag verschwunden
   ist.
