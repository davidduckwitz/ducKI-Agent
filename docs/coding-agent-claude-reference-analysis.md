# Ducki Coding-Agent: Analyse und Verbesserungsplan

Stand: 2026-09-22. Gegenstand ist ausschließlich der Coding-Agent von ducki-node.

## Ergebnis

Der größte Hebel liegt in belastbarer Kontextfortführung und belegtem, projektgebundenem Lernen. Ducki hat bereits viele der notwendigen Laufzeitmechanismen. Ein kompletter Neubau oder ein wesentlich längerer Systemprompt wäre derzeit schlechter begründet als gezielte Verbesserungen.

Diese Analyse ändert keinen Laufzeitcode. Sie bezieht sich auf den aktuellen Arbeitsbaum einschließlich bereits vorhandener, uncommitteter Änderungen. Der ältere `docs/coding-agent-upgrade-plan.md` vom August ist kein verlässlicher Ist-Zustand mehr.

## Referenz und Aussagegrenzen

Untersucht wurde [yasasbanukaofficial/claude-code](https://github.com/yasasbanukaofficial/claude-code/tree/a371abbe75ffa0d0a3c92290e2bbf56a7ef54367/src), Commit `a371abbe75ffa0d0a3c92290e2bbf56a7ef54367`. Das README bezeichnet die Inhalte als aus einer veröffentlichten Sourcemap extrahierten Quellcode. Es ist kein offizielles Anthropic-Repository; Authentizität, Vollständigkeit und Übereinstimmung mit einer aktuellen Produktversion wurden nicht unabhängig bestätigt. Hier werden Architekturideen ausgewertet, kein Referenzcode übernommen.

Gelesene Schwerpunkte: `QueryEngine.ts`, `constants/systemPromptSections.ts`, `services/compact/{microCompact,prompt}.ts`, `services/SessionMemory/prompts.ts`, `services/extractMemories/prompts.ts`, `services/autoDream/consolidationPrompt.ts`, `tools/SkillTool/prompt.ts`. Feature-Flags bedeuten, dass vorhandener Code nicht zwangsläufig überall aktiv ist. Die Analyse ist ein fokussierter Vergleich, kein vollständiges Audit beider Repositories.

## Bereits vorhanden und zu erhalten

- Makrozyklus aus Planung, Ausführung und deterministischer Verifikation; getrennte Ergebnisse für verifiziert und unverifiziert.
- Strukturierte Todos, Status-Tool, Checkpoints und automatische Diagnostik nach Änderungen.
- Read-only-Explorer mit eigenem Kontext für größere Suchaufgaben.
- Fehlerreflexion mit tatsächlichem Verify-Output und Hinweisen auf zuvor ausgeschlossene Ansätze; über die öffentliche `createCodingAgent`-Factory eingebunden.
- Stabiler Systemprompt und separater dynamischer Kontext in `agent.ts:7876`; Anthropic-Cache-Metadaten sind bereits implementiert.
- Deduplizierungsmetadaten für wiederholte Reads in `agent.ts:6251`.
- Automatische Memory-Kandidaten bleiben standardmäßig `pending`; das Memory-System besitzt bereits Neuigkeits-/Ähnlichkeitsprüfungen.
- `isolatedMemory: true` in `coding-agent.ts:1114` schützt Coding-Läufe vor sachfremdem Chat-Wissen.

Insbesondere Prompt-Caching, Explorer, Checkpoints und strukturierte Todos sollten nicht erneut als fehlende Features geplant werden.

## 1. Kontextkompression: höchste Priorität

### Belegte Befunde

`packages/agent/src/context/tiered-compressor.ts`:

- Tier 1 behält ältere Assistant-Nachrichten und entfernt ältere Tool-Nachrichten anhand der Rolle (`:159`). Damit kann ein Tool-Aufruf erhalten bleiben, während sein Ergebnis verschwindet. Ob daraus ein Providerfehler entsteht, hängt von dessen nachgelagerter Normalisierung ab; die Kompressionsfunktion selbst garantiert keine vollständigen Paare.
- Tier 2 schneidet jede Nachricht vor der Zusammenfassung auf 500 Zeichen und den gesamten Zusammenfassungseingang auf 4.000 Zeichen ab (`:228–238`). Wichtige Fehlermeldungen oder Nutzerkorrekturen am Ende längerer Inhalte erreichen das Modell dann überhaupt nicht.
- Tier 3 behält nur die letzten N Nicht-System-Nachrichten (`:215`), ohne verpflichtenden Arbeitsstand. Die Coding-Schicht liefert zwar Plan/Status nach, aber nicht automatisch jede frühere Einschränkung und Entscheidung.

Zusätzlich enthält der Legacy-Kompressor zwei konkrete Codeprobleme:

- `conversation/compressor.ts:72`: Cache-Schlüssel bestehen nur aus Start-/Endindex. Geänderte Inhalte an gleichen Indizes können eine alte Zusammenfassung erhalten. In `Agent` wurde kein Aufruf von `clearCache()` gefunden.
- `conversation/compressor.ts:162`: `end` ist schon eine absolute exklusive Grenze. `i + end - 1` zählt den Offset nochmals. Bei `i=50, end=100` wird bis Index 149 zusammengefasst statt bis 99; Bereiche überlappen und können in den eigentlich unverändert zu erhaltenden Bereich reichen.

### Übertragbares Prinzip

Die Referenz ersetzt bei Microcompaction Inhalte ausgewählter Tool-Ergebnisse durch einen Platzhalter und behält deren Zuordnung bei. Ihre ausführliche Kompressionsvorlage und Session-Notizen erhalten Ziel, aktuelle Arbeit, Fehler, offene Aufgaben und nächsten Schritt explizit.

Quellen: [Microcompaction](https://github.com/yasasbanukaofficial/claude-code/blob/a371abbe75ffa0d0a3c92290e2bbf56a7ef54367/src/services/compact/microCompact.ts), [Kompressionsvorlage](https://github.com/yasasbanukaofficial/claude-code/blob/a371abbe75ffa0d0a3c92290e2bbf56a7ef54367/src/services/compact/prompt.ts), [Session Memory](https://github.com/yasasbanukaofficial/claude-code/blob/a371abbe75ffa0d0a3c92290e2bbf56a7ef54367/src/services/SessionMemory/prompts.ts).

### Empfehlung für Ducki

1. Vor jeder verlustreichen Kompression einen strukturierten Arbeitsstand erzeugen: Ziel, Nutzerauflagen, abgeschlossene/offene Todos, relevante Dateien, letzte Verifikation, verworfene Ansätze und nächster Schritt.
2. Deterministische Fakten aus Todos, Checkpoints und Verifier übernehmen; das LLM ergänzt nur kompakte Erklärungen.
3. Tool-Aufruf/-Ergebnis-Zuordnungen erhalten und veraltete große Inhalte gezielt ersetzen. Aktuelle Fehlerausgaben bevorzugen.
4. Budget nach der Kompression erneut prüfen; eine Tier-Auswahl allein garantiert noch keine ausreichende Reduktion.
5. Legacy-Cache nach Nachrichteninhalt und Kontextidentität adressieren; Bereichsfehler korrigieren.

Abnahmekriterien: Nach erzwungener Kompression bleibt ein früheres Nutzerverbot erhalten; keine offenen Tool-Aufrufe ohne zugehörige Ergebnisse; keine erneute Bearbeitung erledigter Schritte; Cache reagiert auf geänderte Inhalte; keine überlappenden Summary-Bereiche.

## 2. Prompts: Widersprüche beseitigen und Verifikation präzisieren

`coding-agent.ts:55` verbietet erneutes Lesen kategorisch und behauptet, der Inhalt sei noch im Gespräch. `coding-agent.ts:3561` erklärt dagegen zutreffend, dass Kontext gekürzt worden sein kann. Auch Änderungen durch andere Prozesse sind ein Grund für einen erneuten Read.

Vorgeschlagene Ersatzregel:

> Nutze bereits gelesenen Code, solange er im aktuellen Kontext vollständig genug und unverändert ist. Lies den relevanten Bereich erneut nach Kontextkürzung, externen Änderungen, einem fehlgeschlagenen Edit oder Zweifeln an seiner Aktualität. Vor einem Edit muss die aktuelle Fassung bekannt sein.

Die Regel „nach jeder Änderung erneut lesen oder Build/Test“ sollte ferner Evidenzarten unterscheiden: Ein Read bestätigt den Dateistand, Diagnostik prüft bestimmte statische Fehler, ein Test prüft Verhalten. Keine dieser Prüfungen ist pauschal mit den anderen gleichzusetzen.

Vorgeschlagene Ergänzung:

> Belege jede Fertigmeldung mit den tatsächlich ausgeführten, zum Änderungsziel passenden Prüfungen. Nenne nicht ausgeführte Prüfungen ausdrücklich. Ein erfolgreicher Datei-Write oder Read ist kein Beweis für korrektes Verhalten.

Prompt-Aufteilung: kurze stabile Grundregeln, genaue Tool-Verträge, projektspezifische Hinweise und kompakter dynamischer Arbeitsstand. Die Referenz behandelt stabile und volatile Prompt-Abschnitte ausdrücklich unterschiedlich. Ducki macht die grundlegende Cache-Trennung bereits; der nächste Schritt sind Konsistenzprüfungen und Messung der tatsächlich gesendeten Prompts.

Quelle: [Systemprompt-Abschnitte](https://github.com/yasasbanukaofficial/claude-code/blob/a371abbe75ffa0d0a3c92290e2bbf56a7ef54367/src/constants/systemPromptSections.ts).

## 3. Learning: echte Persistenz und Projektbezug

### Bestehendes SkillLearner-Gerüst

`packages/agent/src/skills/skill-learner.ts` ist noch keine vollständige Lernpipeline:

- `extractUrlContent()` sendet nur die URL an `provider.generate`; diese Funktion lädt keinen Quellinhalt herunter.
- `learnFromFile()` liefert ausdrücklich „not yet implemented“.
- `saveSkill()` protokolliert nur. Die aufrufenden Methoden melden dennoch `success: true`.
- Die Suche nach `SkillLearner`/`learnFromSource` in TypeScript unter `packages` und `apps` fand ausschließlich die Definition selbst. Eine produktive Einbindung wurde damit nicht nachgewiesen.

Diese Befunde betreffen dieses Gerüst, nicht pauschal das gesamte Ducki-Memory-System. Letzteres speichert bereits Erinnerungen und besitzt eine Freigabeschranke.

### Empfehlung

Arbeitszustand, Projektwissen und wiederverwendbare Skills getrennt behandeln:

| Speicher | Inhalt | Lebensdauer |
|---|---|---|
| Laufzustand | Ziel, Todos, Fehler, nächster Schritt | aktueller Auftrag / Wiederaufnahme |
| Projektwissen | bestätigte Konventionen, wiederkehrende Fehlerursachen | projektgebunden, versionierbar |
| Skill | mehrfach bewährtes Vorgehen mit Auslöser und Verifikation | längerfristig, gezielt ausgewählt |

`isolatedMemory` beibehalten. Für projektübergreifendes Wiederverwenden innerhalb desselben Projekts einen stabilen Projekt-Identifier ergänzen, statt globale Chat-Suche wieder freizuschalten.

Empfohlene Pipeline:

1. Quelle tatsächlich lesen; Herkunft, Zeitpunkt und bei Code einen Commit-/Inhaltsbezug festhalten.
2. Nach einer belegten Lösung oder expliziten Nutzerkorrektur einen Lernkandidaten erzeugen. Fehlgeschlagene Ansätze nur als begrenzte Beobachtung speichern, nicht als bestätigte Lösung.
3. Schema: Projekt, Auslöser, Beobachtung, empfohlene Handlung, Verifikation, Evidenz, Gültigkeitsbedingungen, Status.
4. Kandidat gegen vorhandenes Wissen auf Duplikate/Widersprüche prüfen. Bestehende `pending`-/`approved`-Logik nutzen.
5. Atomar speichern, erneut laden und erst dann Erfolg melden. Das Modell darf Quelldaten nicht in übergeordnete Anweisungen umdeuten.
6. Nur wenige relevante, freigegebene Einträge in künftige Coding-Läufe laden. Ein erfolgreicher einzelner Tool-Aufruf genügt nicht als Beleg für eine erfolgreiche Coding-Lösung.
7. Bei ausreichendem neuen Material konsolidieren: Dubletten zusammenführen, widerlegte Aussagen ersetzen, veraltete Einträge aus dem aktiven Index entfernen. Kein zusätzlicher LLM-Aufruf nach jedem Edit.

Die Referenz liefert hierfür die Trennung von Extraktion und Konsolidierung sowie einen knappen Index statt eines ständig wachsenden Wissensblocks. Das lässt sich mit Duckis Datenbank umsetzen; Markdown-Dateien sind dafür nicht zwingend notwendig.

Quellen: [Memory-Extraktion](https://github.com/yasasbanukaofficial/claude-code/blob/a371abbe75ffa0d0a3c92290e2bbf56a7ef54367/src/services/extractMemories/prompts.ts), [Konsolidierung](https://github.com/yasasbanukaofficial/claude-code/blob/a371abbe75ffa0d0a3c92290e2bbf56a7ef54367/src/services/autoDream/consolidationPrompt.ts).

Abnahmekriterien: Keine Erfolgsmeldung bei fehlgeschlagenem Schreiben; Erinnerung überlebt Neustart; Projekt A beeinflusst Projekt B nicht; widersprochene Erinnerung wird nicht erneut geladen; unbelegte Modellbehauptung wird nicht automatisch zur bestätigten Regel.

## 4. Laufzeit: Reflexion explizit integrieren

`failure-aware-coding-agent.ts:88` greift per Type-Cast auf den privaten inneren Agenten zu und ersetzt zeitweise `run` sowie `executor.execute`. Die erste Shell-Ausführung nach einem inneren Lauf wird als Makroverifikation interpretiert. Das funktioniert über implizite Reihenfolge und wird bei Erweiterungen fragil.

Empfehlung: explizite Hooks wie `onAttemptFinished`, `onVerificationFailed` und `beforeRetry` im Coding-Lauf; ein gemeinsamer `CodingRunState` und ein gemeinsam aufgelöster Settings-Snapshot. Fehlerreflexion als begrenzte Strategie daran anschließen. Dabei bestehende Verify-/Abbruchsemantik erhalten.

Die erfassten Edit-Aktionen enthalten aktuell nur `write`, `edit`, `append`. Für vollständige Reflexion besser den tatsächlichen Checkpoint-Diff verwenden; Änderungen durch `edit_lines` oder Shell fehlen sonst im direkten Edit-Protokoll.

Dies ist eine Ducki-spezifische Empfehlung aus dem lokalen Code, kein als Benchmark belegter Vorteil des Referenzsystems.

## 5. Validierung und Reihenfolge

Ausgeführt:

```text
pnpm exec vitest run packages/agent/test/tiered-compressor.test.ts packages/agent/test/memory-auto-approval.test.ts packages/agent/test/coding-failure-reflection-integration.test.ts
22 bestanden, 1 fehlgeschlagen (23 Tests in 3 Dateien)
```

Der fehlschlagende Test erwartet sechs Versuche und erhält drei. Sein `stubDb()` liefert über `getAllSettings()` stets eine leere Liste, über `getSetting()` aber den konfigurierten Wert sechs. Hauptlauf und Wrapper lesen dadurch unterschiedliche Werte. Dies belegt zunächst eine inkonsistente Testsimulation, keinen produktiven Fehler bei konsistenter Datenbank. Die doppelten Settings-Ladewege sollten trotzdem vereinheitlicht werden.

Der bestehende Tier-1-Test verwendet Tooltexte als `user`-Nachrichten und akzeptiert unveränderte Nachrichtenanzahl. Er besteht mit `tokensSaved: 0`; damit belegt er weder wirksame Kompression noch Erhalt nativer Tool-Zuordnungen.

Priorisierte Umsetzung:

1. **P1 – Kontextkorrektheit:** Summary-Bereich und Cache reparieren, Tool-Zuordnungen sichern, strukturierten Arbeitsstand erhalten, aussagekräftige Regressionstests ergänzen.
2. **P1 – Promptkonsistenz:** erneutes Lesen bei Kontextverlust erlauben; Dateistand und Verhaltensprüfung unterscheiden.
3. **P2 – Learning vervollständigen:** Quellabruf/Persistenz implementieren, Projektbezug und evidenzbasierte Kandidaten; erst danach produktiv anbinden.
4. **P2 – Reflexionsschnittstellen:** gemeinsame Settings und explizite Laufzeitereignisse statt Methoden-Austausch.
5. **P3 – Konsolidierung und Evaluation:** nur bei ausreichend Lernmaterial, mit begrenztem Budget und gemessenem Nutzen.

Für einen Vorher-/Nachher-Vergleich dieselben Aufgaben mit gleichem Modell und Budget mehrfach ausführen: kleine Bugfixes, mehrere Dateien, erzwungene Kompression, wiederholter Verify-Fehler, Wiederaufnahme und zwei Projekte mit widersprüchlichen Konventionen. Messen: erfolgreich verifizierte Aufgaben, verlorene Vorgaben, unnötige Wiederholungen, Tokenverbrauch, Laufzeit und falsche Fertigmeldungen. Für Learning zusätzlich ein A/B-Vergleich mit ausgeschaltetem Projektgedächtnis. Prozentuale Qualitäts- oder Kostengewinne lassen sich aus dieser Codeanalyse allein nicht seriös angeben.
