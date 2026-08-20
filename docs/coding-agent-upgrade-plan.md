# Coding-Agent: Ist-Analyse, Wettbewerbsvergleich und Upgrade-Plan

Stand: 2026-08-20
Referenz-Systeme: [opencode](https://github.com/anomalyco/opencode), [cline](https://github.com/cline/cline), [pi](https://github.com/earendil-works/pi)

---

## 1. Ist-Zustand

### Architektur

| Ebene | Datei | Rolle |
|---|---|---|
| HTTP-Einstieg | `apps/server/src/routes/coding-agent.ts` | `POST /run`, Budgets aus Settings, WS-Events |
| Datei-/Projekt-API | `apps/server/src/routes/coding.ts` | Projekte, Datei-CRUD im `coding/`-Root |
| Makro-Loop | `packages/agent/src/coding/coding-agent.ts` | plan → verify → iterate über mehrere `agent.run()` |
| Kern-Loop | `packages/agent/src/agent.ts` (7135 Zeilen) | Tool-Parsing, Iterationen, Kontextfenster |
| Tools | `packages/tools/src/{filesystem,shell,git,skills}.ts` | 13 fs-Aktionen, Shell, Git, Skills |
| Sandbox | `packages/agent/src/coding/scoped-{filesystem,shell}-tool.ts` | cwd/basePath-Scoping |
| UI | `apps/web/src/components/coding/*` | Dateibaum, Editor-Tabs, Agent-Panel, Plan-Panel |

### Was heute gut ist

- **Deterministische Verifikation** statt Selbsteinschätzung: `verifyCommand`-Exitcode entscheidet über `verified: true`. Das ist besser gelöst als bei vielen OSS-Agenten, die "der Agent sagt fertig" als Erfolg werten.
- **Nicht-Konvergenz-Erkennung**: drei identische Verify-Fehler in Folge brechen den Run ab (`identicalFailureStreak`) statt das Budget zu verbrennen.
- **Atomare Writes + `.bak`** (`atomicWrite` in `filesystem.ts`) – kein halb geschriebenes File bei abgeschnittener Completion.
- **`edit` mit Eindeutigkeitsprüfung** (`oldString` muss genau 1× matchen, sonst Fehler mit Handlungsanweisung) – konzeptgleich mit opencode/Claude Code, robuster als Clines SEARCH/REPLACE-Blöcke, die dort laufend Bug-Reports produzieren.
- **Heredoc-Block-Format** (`[TOOL:filesystem action=write path=…] … [/TOOL]`) umgeht das JSON-Escaping-Problem – ein echter Vorteil bei schwachen lokalen Modellen.
- **Tool-Staging** für große Ergebnisse (Preview + `__toolStagingId`) – dasselbe Muster wie opencodes `truncate.ts`.
- **Read-before-Edit-Hook** und Shell-Approval-Policy als Disziplin-Hooks.

---

## 2. Lücken gegenüber State of the Art

| Fähigkeit | opencode | cline | pi | ducki |
|---|---|---|---|---|
| Code-Intelligenz (LSP/AST) | `lsp.ts`-Tool: Definition, Referenzen, Hover, Call-Hierarchie, Symbole | tree-sitter (`list_code_definition_names`), Linter-/Compiler-Fehler live | – | **fehlt** |
| Subagent / Task-Tool | `task.ts` | – | Extensions | **fehlt** |
| Todo-/Plan-State als Tool | `todo.ts` | Focus Chain | – | nur Textmarker + Regex |
| Suche | `grep.ts`/`glob.ts` (ripgrep-basiert) | ripgrep | – | naiver JS-Walk, **ohne** `.gitignore`/`node_modules`-Ausschluss |
| Shell | async, Streaming, Hintergrund-Prozesse | Terminal-Watch in Echtzeit | async | **`execSync`** – blockiert den Node-Event-Loop |
| Diff-Review / Checkpoints | Permissions | Diff pro Edit + Checkpoints zum Zurückrollen | – | **fehlt** (nur einstufiges `.bak`) |
| Prompt-Caching | ja | ja | Session-IDs cachen Provider-Calls | **0 Treffer für `cache_control`** |
| Read-Dedupe im Verlauf | – | ersetzt ältere Reads derselben Datei durch Notiz | – | **fehlt** |
| Zeilennummern beim `read` | `<line>: <content>`, 2000 Zeilen Default | ja | – | **fehlt** |

### 2.1 Kein Code-Intelligenz-Layer (größter Qualitätshebel)

Der Agent "sieht" einen Typfehler erst, wenn am Ende eines ganzen Attempts `npx tsc --noEmit` über das komplette Projekt läuft. opencode gibt dem Modell LSP als Tool, cline liest Linter-/Compiler-Diagnostics automatisch nach jedem Edit. Folge bei euch: eine kaputte Zeile kostet einen kompletten Attempt (bis zu 100 Iterationen + voller Build) statt eine Tool-Antwort.

### 2.2 Suche skaliert nicht

`packages/tools/src/filesystem-search.ts`:
- `walkDir()` hat **keine** Ignore-Liste – `node_modules`, `.git`, `dist` werden mitgelaufen und mitgegrept.
- `grepFiles()` liest jede Datei komplett in den Speicher und **kompiliert die Regex pro Zeile neu** (`new RegExp(pattern, flags)` in der Zeilenschleife).
- `globFiles()` sammelt erst `limit * 4` Dateien und filtert dann – bei einem npm-Repo laufen die 4000 Slots voll, bevor der Quellcode überhaupt erreicht ist.

Das ist gleichzeitig ein Geschwindigkeits- **und** ein Token-Problem: der Agent bekommt Treffer aus `node_modules` zurück und liest daraufhin falsche Dateien.

### 2.3 Shell blockiert und kann keine Prozesse

`packages/tools/src/shell.ts` nutzt `execSync`/`execFileSync`. Konsequenzen:
- Ein 30-Sekunden-Build blockiert **den gesamten Express-Server** (kein WS-Event, kein zweiter Request, kein Stop-Button).
- Kein Streaming der Ausgabe – der Agent sieht nichts bis zum Ende.
- Keine Hintergrundprozesse: `npm run dev` ist unmöglich, damit auch kein Browser-Verify gegen einen laufenden Dev-Server.
- Erfolgsfall meldet immer `exitCode: 0` fest verdrahtet.

### 2.4 Approval-Whitelist ist inkonsistent zum eigenen Verify

`coding-agent.ts` erlaubt nur `ls, pwd, cd, cat, grep, find, npm, yarn, git, node`.
`detectDefaultVerifyCommand()` liefert aber `npx tsc --noEmit`. Der Run selbst kommt durch, weil `executor.execute("shell", …)` direkt aufgerufen wird und die `beforeTool`-Hooks umgeht – **das Modell** darf denselben Befehl aber nicht ausführen. Ebenfalls blockiert: `pnpm` (obwohl das Repo `pnpm-workspace.yaml` hat), `npx`, `tsc`, `vitest`, `python`, `cargo`, `make`, `rg`, `mkdir`, `echo`.

### 2.5 Read-before-Edit ist umgehbar

Der Hook in `coding-agent.ts` vergleicht **rohe Pfad-Strings** und nimmt `write` explizit aus:
```ts
if (!hasBeenRead && action !== "write")
```
Damit darf das Modell eine existierende Datei komplett überschreiben, ohne sie je gelesen zu haben – genau der Fehlerfall, den die Regel verhindern soll. Zusätzlich: `read` mit `src/x.ts` und `edit` mit `./src/x.ts` gelten als verschiedene Dateien. `filesRead` wird außerdem nie zurückgesetzt (Instanz-Feld, kein Reset in `run()`).

### 2.6 Phasen-Tracking ist fragil

`extractAndEmitPhaseEvents()` sucht Textmarker (`>> PHASE: EXPLORE`) per `indexOf` in der Antwort. Ein Modell, das die Marker vergisst oder umformuliert, erzeugt keine Events. opencode und cline halten den Fortschritt stattdessen in einem **Tool** (`todo.ts` / Focus Chain) – strukturierter State statt Prosa-Parsing.

### 2.7 Kein Diff/Checkpoint im UI

`apps/web/src/components/coding/*`: kein Treffer für `diff`, `approve`, `checkpoint`, `revert`. Der Nutzer sieht das Ergebnis, nicht die Änderung. Clines Kernversprechen ist genau das Gegenteil.

---

## 3. Token- und Geschwindigkeitsanalyse

### 3.1 Prompt-Caching: der mit Abstand größte Hebel

`grep -rn "cache_control" packages/` → **0 Treffer**. Bei Anthropic bedeutet ein Cache-Hit ~90 % Rabatt auf den gecachten Prefix. Ein Coding-Run mit 40 Iterationen schickt den kompletten System-Prompt (Direktive + `TOOL_CALL_FORMAT_BLOCK` + Tool-Definitionen + Skills, leicht 8–15k Tokens) **40-mal ungecacht**.

Erschwerend: der System-Prompt ist pro Iteration **nicht stabil**. In `agent.ts:5820` wird gebaut:
```
`${clippedPrompt}${clippedDynamicMemory}${checklistHint}${runJournalHint}`
```
`checklistHint` und `runJournalHint` ändern sich jede Iteration und hängen **hinten am System-Prompt**. Damit bricht auch das automatische Prefix-Caching von OpenAI/OpenRouter. Der Fix ist strukturell und billig: statischen Teil (Direktive + Tool-Format + Tool-Definitionen) einfrieren und als eigene, gecachte System-Message führen; volatile Hinweise als **letzte User-Message** anhängen.

### 3.2 Kontextfenster wird jede Iteration neu zusammengesetzt

`buildConversationWindow()` läuft die Historie **rückwärts** und schneidet bei `maxContextChars` ab. Tool-Ergebnisse sind explizit vom Clipping ausgenommen ("never skip them"). Ergebnis: ein einziger großer Datei-Read kann das Char-Budget füllen, die Zielbeschreibung fällt hinten raus – und dieselben Bytes werden in jeder Iteration erneut bezahlt.

Was fehlt:
- **Read-Dedupe** (cline): ältere Reads derselben Datei durch `[entfernt – siehe letzten Read]` ersetzen. Bei einem Run, der eine Datei 5× liest, spart das direkt 4× die Dateigröße.
- **Token-basiertes statt zeichenbasiertes Budget.** `estimatePromptTokens = len/4` ist eine Konstante; `packages/agent/src/context/token-counter.ts` ist besser, wird aber im Coding-Pfad nicht genutzt.
- **`ContextManager`** (`packages/agent/src/context/context-manager.ts`, 380 Zeilen, 4 Pruning-Strategien) ist implementiert und hat **0 Referenzen in `agent.ts`** – toter Code, während der Loop eine eigene, schwächere Ad-hoc-Logik fährt.

### 3.3 Iterationsbudget ist zu großzügig

`maxIterations: 100` pro Attempt × `maxAttempts: 4` = bis zu 400 LLM-Calls für ein Ziel. Zum Vergleich: die meisten SOTA-Agenten liegen bei 20–50 pro Turn mit Compaction dazwischen. Ohne Read-Dedupe und Caching ist ein einziger entgleister Run sehr teuer.

### 3.4 Verify läuft am Ende statt kontinuierlich

Ein voller `tsc --noEmit` über ein Monorepo dauert 10–60 s und läuft bis zu 4× pro Run. Ein LSP-Diagnostic auf **eine** Datei nach dem Edit dauert Millisekunden und fängt 80 % derselben Fehler.

### 3.5 Kein Batching in der Explorationsphase

opencodes `read.txt` sagt dem Modell explizit: *"Call tool in parallel for multiple files"* und *"avoid reading small repeated chunks; use larger windows"*. Eure `CODING_DIRECTIVE` sagt dazu nichts, obwohl der Executor Parallelbatches bereits kann (`executeParallel`, `toolGraph.buildExecutionPlan`). Reine Prompt-Änderung, halbiert die Round-Trips der Explore-Phase.

---

## 4. Maßnahmen, priorisiert

### Phase A – schnelle Gewinne (1–2 Tage, kein Architekturumbau)

| # | Maßnahme | Datei | Wirkung |
|---|---|---|---|
| A1 | Ignore-Liste (`node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`) + Regex einmal kompilieren + Binärerkennung vor dem Read | `packages/tools/src/filesystem-search.ts` | Suche 10–100× schneller, keine Müll-Treffer |
| A2 | Whitelist erweitern: `npx, pnpm, tsc, node, python, pytest, vitest, jest, cargo, make, rg, mkdir, echo, type, dir` | `coding-agent.ts` | beseitigt die Inkonsistenz aus 2.4 |
| A3 | `read` gibt Zeilennummern (`  12: const x = 1`) + Default-Limit 2000 Zeilen, 2000 Zeichen/Zeile | `filesystem.ts` | präzisere Edits, weniger Fehlversuche |
| A4 | `write` in den Read-before-Edit-Hook aufnehmen, wenn die Datei existiert; Pfade über `resolve()` normalisieren; `filesRead` in `run()` zurücksetzen | `coding-agent.ts` | schließt 2.5 |
| A5 | Direktive um Parallel-Read und "grep vor read" ergänzen | `CODING_DIRECTIVE` | −30–50 % Iterationen in der Explore-Phase |
| A6 | `maxIterations` Default 100 → 40, dafür Compaction dazwischen | `coding-agent.ts` / Settings | Kostendeckel |

### Phase B – Token-Ökonomie (der eigentliche Kosten-Hebel)

| # | Maßnahme | Wirkung |
|---|---|---|
| B1 | **Prompt-Caching**: statischer System-Block (Direktive + Tool-Format + Tool-Definitionen) als eigene Message mit `cache_control: {type: "ephemeral"}` in `claude-provider.ts`; volatile Hints (`checklistHint`, `runJournalHint`, dynamic memory) ans **Ende der Message-Liste** verschieben, nicht ans Ende des System-Prompts | größte Einzelersparnis, bei 40 Iterationen realistisch 60–80 % der Input-Kosten |
| B2 | **Read-Dedupe**: in `buildConversationWindow()` ältere `tool`-Ergebnisse für denselben `filesystem/read`-Pfad durch eine Kurznotiz ersetzen | spart typisch 20–40 % Kontext in Edit-Iterationen |
| B3 | **Token-basiertes Budget** statt `maxContextChars`; `TokenCounter` + `ContextManager` tatsächlich verdrahten statt der Ad-hoc-Logik | verhindert Overflow-Retries (jeder kostet einen vollen Call) |
| B4 | Verify-Output nicht nur kürzen, sondern **auf die Fehlerzeilen filtern** (`error TS`, `FAIL`, Stacktrace-Kopf) statt Head/Tail-Schnitt | `truncateVerifyOutput` liefert heute 4000 Zeichen, oft davon 3500 Rauschen |
| B5 | Kleines Modell für Explore/Grep-Auswertung, großes Modell nur für Edit/Diagnose (Router in `createCodingAgent`) | 2–5× Kostenfaktor auf der teuersten Phase |

### Phase C – Fähigkeitssprung

| # | Maßnahme | Vorbild |
|---|---|---|
| C1 | **Diagnostics-Tool**: `tsc --noEmit --pretty false` inkrementell bzw. `tsserver`/`typescript`-API auf die geänderten Dateien; automatisch **nach jedem Edit** aufrufen und das Ergebnis als Tool-Antwort zurückgeben | cline (Linter-Watch), opencode `lsp.ts` |
| C2 | **`todo`-Tool** statt Textmarker-Parsing; die vorhandene `checklist/checklist-manager.ts` als Backend nutzen, Phasen-Events daraus speisen | opencode `todo.ts`, cline Focus Chain |
| C3 | **Subagent/Task-Tool** für Exploration: eigener Kontext, gibt nur die Antwort zurück ("welche Datei enthält X") – der Hauptkontext bleibt sauber | opencode `task.ts` |
| C4 | **Async Shell** (`spawn` + Streaming + `background: true` + Prozess-Registry) | alle drei Referenzen |
| C5 | **Diff-Review + Checkpoints im UI**: Snapshot-Commit in ein Shadow-Git pro Attempt, Diff-Ansicht im `CodingAgentPanel`, "Rückgängig" auf Attempt-Ebene | cline (Kernfeature) |
| C6 | **Symbol-Outline** (tree-sitter) statt Volldatei-Read: `list_symbols` liefert Signaturen einer Datei in ~5 % der Tokens | cline `src/services/tree-sitter` |

---

## 5. Umsetzungsstand (2026-08-20)

Alle Maßnahmen aus Phase A, B und C sind implementiert.

| # | Maßnahme | Umgesetzt in |
|---|---|---|
| A1 | Ignore-Liste, .gitignore, Regex einmal kompiliert, Binärerkennung, Match während des Walks | `packages/tools/src/filesystem-search.ts` |
| A2 | Shell-Whitelist auf die reale Toolchain erweitert | `CODING_ALLOWED_SHELL_COMMANDS` |
| A3 | `read` mit Zeilennummern, 2000-Zeilen-Default, Zeilenbreiten-Cap, `raw:true`-Opt-out | `packages/tools/src/filesystem.ts` |
| A4 | Read-before-Edit greift auch bei `write` auf existierende Dateien, Pfade normalisiert, Reset pro Run | `coding-agent.ts` |
| A5 | Direktive: grep vor read, parallele Reads, keine Re-Reads, outline für große Dateien | `CODING_DIRECTIVE` |
| A6 | Iterationsbudget 100 → 40 (Tiers 15/30/60) | `coding-agent.ts`, `routes/coding-agent.ts` |
| B1 | Prompt-Caching: stabiler System-Prefix + `cache_control`, volatile Hints als letzte Nachricht | `agent.ts`, `adapters/anthropic-adapter.ts`, `claude-provider.ts`, `openai-provider.ts` |
| B2 | Read-Dedupe superseded Ergebnisse im Kontextfenster | `agent.ts` (`buildToolResultDedupeKey`) |
| B3 | Kontextbudget aus dem Modellfenster statt fixer Zeichenzahl | `agent.ts` (`TokenCounter`) |
| B4 | Verify-Ausgabe auf Diagnose-Zeilen reduziert statt Head/Tail-Schnitt | `condenseVerifyOutput` |
| B5 | Optionales günstiges Modell für die Exploration | `DUCKI_EXPLORE_MODEL` |
| C1 | Diagnostics-Tool (warmer LanguageService) + automatisch nach jedem Edit | `packages/tools/src/diagnostics.ts`, `coding/auto-diagnostics.ts` |
| C2 | `todo`-Tool als strukturierter Fortschritt statt Textmarker-Parsing | `coding/todo-tool.ts`, `CodingTodoStrip.tsx` |
| C3 | `explore`-Subagent mit eigenem, verworfenem Kontext | `coding/explore-tool.ts` |
| C4 | Shell async (spawn), echte Exitcodes, Hintergrundprozesse | `packages/tools/src/shell.ts` |
| C5 | Checkpoints (Shadow-Git) + Diff + Restore, inkl. UI | `coding/checkpoints.ts`, `CodingChangesPanel.tsx` |
| C6 | Symbol-Outline als `filesystem action:"outline"` | `packages/tools/src/outline.ts` |

Gemessen an diesem Repo: Diagnostics eines Files 3,7 s kalt / 1,0 s warm gegenüber ~30–60 s für `tsc -p packages/agent --noEmit`. Repo-weites Grep über `**/*.ts` in 0,86 s ohne `node_modules`-Treffer.

---

## 6. Nachtrag: doppelte Chat-Sessions bei Plan-Ausführung (behoben)

**Symptom:** Wird im normalen Chat ein Coding-Projekt geplant und ausgeführt, entstehen zwei Chat-Sessions.

**Ursache (Server).** Der „Umsetzen"-Button in [ChatContainer.tsx](apps/web/src/components/chat/ChatContainer.tsx) postet nach `POST /api/coding-agent/run` — ohne `conversationId`. Die Route rief `CodingAgent.run(goal)` auf, und `run()` begann bedingungslos mit `startConversation({ name: "CodingAgent: <goal>" })`. Ergebnis: eine zweite Conversation, die das gesamte Run-Transkript aufnimmt, während der Chat, den der Nutzer ansieht, nur die nachträglich eingefügte Zusammenfassung bekommt.

Der Plan-Pfad über `POST /api/plans/:id/execute` war davon **nicht** betroffen — er nutzt bereits `loadConversation()` + `runOnExistingConversation()`. Genau dieses Verhalten hat `run()` jetzt auch:

- `CodingRunOptions.conversationId` — ist sie gesetzt, wird die Conversation geladen statt eine neue angelegt; `onConversationStarted` feuert weiterhin (die Stop-Registrierung braucht das in beiden Fällen).
- Die Route validiert die ID gegen die DB und antwortet mit 404 statt einem undurchsichtigen Fehler aus dem Agent-Inneren.
- Der Chat sendet seine `conversationId` mit.

Nebeneffekt: Der Stop-Button erreicht den Run jetzt, weil die registrierte Conversation-ID dem Client bekannt ist.

**Ursache (Client).** In [CodingWorkspace.tsx](apps/web/src/components/coding/CodingWorkspace.tsx) legten **drei** Stellen unabhängig eine `[Coding] <project>`-Conversation an: der Projektauswahl-Effekt, `sendCodingPrompt` und `executePlan`. Nur der Effekt hatte eine Sperre — und die schützte ihn lediglich vor sich selbst. Beim Plan-Handoff aus dem Chat feuern alle drei im selben Tick: der Effekt startet die Erstellung für das frisch angelegte Projekt, „Execute" läuft los, bevor die Antwort da ist, und beide legen eine an.

Behoben durch eine einzige `ensureProjectConversation(project)`, die nebenläufige Aufrufer dasselbe Promise abwarten lässt und die aufgelöste ID in eine synchron lesbare Ref schreibt, bevor das Promise verworfen wird — es bleibt keine Lücke, in der ein Aufrufer sie verpassen kann. Es gibt jetzt genau einen `createConversation`-Aufruf in der Datei.

Regression abgedeckt in [coding-agent-conversation-reuse.test.ts](packages/agent/test/coding-agent-conversation-reuse.test.ts).


---

## 7. Nachtrag: Seiteneffekt-Audit der Phasen A–C

Durchgang über die eigenen Änderungen, gezielt auf ungewollte Nebenwirkungen. Sechs echte Funde, alle behoben.

| Fund | Wirkung | Behebung |
|---|---|---|
| **Kontextbudget kollabierte bei unbekannten Modellen** | `TokenCounter.getModelConfig` fällt bei jedem nicht gelisteten Namen auf `local` (4096 Tokens) zurück. Abzüglich 8192 reservierter Output-Tokens ergibt das ein negatives Budget → 4 000 statt 120 000 Zeichen Kontext. Betroffen: praktisch jedes lokale Modell und die meisten OpenRouter-Slugs. | Neues `findModelConfig()` ohne Fallback; das Budget wird nur bei **bekanntem** Fenster abgeleitet, sonst bleibt der konfigurierte Wert. Fuzzy-Match nur noch in eine Richtung (Name enthält Key), längster Treffer gewinnt. |
| **Suchtreffer waren nicht rückführbar** | glob/grep gaben Pfade relativ zum durchsuchten Ordner zurück. Bei einer Suche in einem Unterordner ließ sich der Treffer nicht direkt an `read` zurückgeben. | Pfade jetzt relativ zum **Scope-Root** (Sandbox bzw. Shared-Workspace) — derselben Basis, gegen die `read` auflöst. Zusätzlich `searchedIn` im Ergebnis. |
| **Zeilennummern nur der Coding-Direktive erklärt** | Der normale Agent bekommt dasselbe `<n>: `-Format, wusste aber nichts davon — und hätte die Präfixe in eine Datei zurückschreiben können. | Erklärung in `DEFAULT_SYSTEM_PROMPT` ergänzt (inkl. grep-vor-read, Parallel-Reads, outline). |
| **„Read-only" Explorer war nicht read-only** | Der `Agent`-Konstruktor registriert automatisch `memory`, `project`, `task`, `history`, `gateway`, Vision-, Script- und Plan-Tools. `gateway` verschickt Nachrichten nach Discord/Telegram, Script-Tools führen Code aus. Dazu landeten all diese Beschreibungen im Prompt jeder Explorer-Iteration — genau der Overhead, den das Tool vermeiden soll. | Explorer-Executor auf `filesystem` + `submit_solution` beschränkt. |
| **`child.kill()` traf nur die Shell** | Bei `shell: true` beendet ein Kill nur `cmd /c` bzw. `sh -c`, nicht den gestarteten Prozess — ein Dev-Server hielt seinen Port weiter. | `killTree()`: Windows über `taskkill /T /F`, POSIX über Prozessgruppe (Kinder werden dafür detached gestartet). Verifiziert: 2 Prozesse gestartet, 0 übrig. |
| **`cache_control` ging an alle OpenAI-kompatiblen Backends** | Der Breakpoint erzwingt die Content-Parts-Form für die System-Message. LM Studio, Ollama und llama.cpp erben denselben Provider und akzeptieren teils nur einen String. | Opt-in pro Backend; nur `OpenRouterProvider` sendet ihn. OpenAI cached ohnehin automatisch, lokale Runtimes haben keinen Cache. |

Kleinere Anpassungen: `.ducki-checkpoints` in die Such-Ignore-Liste (der Checkpoint-Store liegt in jedem Projekt), `stdin` gespawnter Prozesse wird sofort geschlossen (ein Kommando mit Rückfrage lief vorher in den Timeout statt sofort in EOF — gemessen 95 ms statt 8 s).

### Testlauf-Segfault behoben

Die Suite stürzte in etwa jedem dritten Lauf mit Exit 139 ab — immer **nach** allen grünen Tests, also beim Teardown. Ursache ist das native `@libsql/client`-Addon, das im Worker-Thread-Pool unzuverlässig entladen wird. `pool: "forks"` in [vitest.config.ts](vitest.config.ts) behebt das: 0 Fehler über wiederholte Läufe gegenüber 1 von 3, bei identischer Laufzeit (~11–12 s).

---

## 8. Coding-Projekt vollständig löschen

Bis dahin ließ sich ein Coding-Projekt gar nicht entfernen. Die vorhandene Löschfunktion (`DELETE /api/projects/:id`) gilt für Datenbank-Projekte mit numerischer ID — Coding-Projekte sind Ordner unter einem Slug und haben keine.

### Backend

| Endpunkt | Zweck |
|---|---|
| `GET /api/coding/projects/:project/deletion-preview` | Dateianzahl, Größe und zugehörige Chats mit Nachrichtenzahl |
| `DELETE /api/coding/projects/:project` | Entfernt Verzeichnis (inkl. Checkpoint-Verlauf) und die zugehörigen Chats |

Die Zuordnung Projekt → Chat liegt im localStorage des Browsers, der Server kennt sie nicht. Gefunden werden die Chats deshalb über zwei Wege gleichzeitig: die Namenskonvention `[Coding] <slug>`, mit der jeder dieser Chats angelegt wird, **und** die vom Client mitgeschickte ID. Keiner der beiden reicht allein — der Client kennt nur den Chat *dieses* Browsers, der Namens-Scan findet auch verwaiste aus anderen Sitzungen.

Eine mitgeschickte ID, die zu einem *anderen* `[Coding] …`-Projekt gehört, wird verworfen: ein veralteter localStorage-Eintrag darf niemals einen fremden Chat mitnehmen. Chats werden vor dem Ordner gelöscht — schlägt das Entfernen des Verzeichnisses fehl, sieht der Nutzer das Projekt noch und kann es erneut versuchen, statt einen gelöschten Ordner mit weiterhin gelistetem Chat vorzufinden.

### Frontend

Papierkorb-Symbol neben der Projektauswahl, Bestätigungsdialog mit konkreten Zahlen statt eines pauschalen „alles". Nach dem Löschen: lokale Zuordnung entfernt, Editor-Tabs und Entwürfe zurückgesetzt, Chat geleert, nächstes Projekt ausgewählt.

**Ein Fund beim Testen:** Direkt nach dem Löschen legte der Auswahl-Effekt sofort eine *neue* Conversation für das gerade gelöschte Projekt an — zwischen dem Entfernen der Zuordnung und dem Umschalten der Auswahl lag ein Render, in dem `selectedProject` noch das gelöschte Projekt nannte und dessen Mapping bereits fehlte. Behoben durch synchrones Abwählen vor dem ersten `await` plus einen Grabstein, den `ensureProjectConversation` prüft. Der Grabstein wird deklarativ wieder aufgehoben, sobald die Projektliste den Slug erneut enthält — nicht an den einzelnen Erstellungspfaden, von denen zwei (Plan-Handoff, `executePlan`) ohnehin nicht über die Create-Mutation laufen.

Regressionstests in [coding-delete.test.ts](apps/server/src/routes/coding-delete.test.ts): Vorschau, Löschen, fremde Chats bleiben unberührt, veraltete ID wird ignoriert, umbenannter Chat wird trotzdem gefunden, Pfad-Ausbruch und fehlendes Projekt werden abgewiesen.

---

## 9. Nachtrag: Abbruch nach „10x in Folge ohne Erfolg"

**Symptom:** Ein Coding-Run bricht bei Iteration 18 mit `consecutiveFailures: 10` ab, letzter Tool-Call `write docs/data-model.md`, Checkliste bei 2/6.

### Ursachenkette

Der Guardrail selbst ist korrekt — er zählt Iterationen, in denen *jeder* Tool-Call fehlschlug. Die Frage war, warum zehn davon in Folge auftraten. Die Kette:

1. Einige echte Fehlschläge auf dem `filesystem`-Tool (falsches `oldString`, fehlendes `content`, eine Disziplin-Blockade).
2. Bei **fünf** Fehlern öffnet der Circuit Breaker — und der ist **pro Tool-Name** geführt, nicht pro Aktion.
3. Damit werden für **60 Sekunden alle** `filesystem`-Calls abgewiesen, einschließlich `read` — also genau der Aktion, zu der jede dieser Fehlermeldungen das Modell auffordert („Use action:'read' on it first").
4. Jede weitere Iteration schlägt vollständig fehl. Nach zehn davon greift der Guardrail und tötet den Run.

Der Circuit-Breaker war hier das falsche Werkzeug: Er existiert, um eine ausgefallene *externe Abhängigkeit* zu schonen. Ein lokales Multi-Action-Tool wie `filesystem` fällt nicht aus — seine Fehler sind Aufruffehler, die das Modell korrigieren soll.

### Behebung

| Änderung | Wirkung |
|---|---|
| `isSystemicToolFailure()` in [circuit-breaker.ts](packages/agent/src/tool-strategy/circuit-breaker.ts) | Nur echte Ausfälle (Timeout, ECONNREFUSED, EACCES, ENOSPC, Tool-Crash) zählen. Aufruffehler bewegen den Breaker gar nicht — weder öffnend noch zurücksetzend. |
| Read-only-Calls umgehen einen offenen Breaker | `read`/`list`/`grep`/`glob`/`stat`/`exists`/`outline`, `git status/diff/log`, `diagnostics`. Beobachten ändert nichts und kann das Tool nicht kaputt gemacht haben — es zu blockieren macht aus einem behebbaren Fehler einen unbehebbaren Run. |
| Read-before-Edit verweigert nur noch **einmal** pro Datei | Eine unbegrenzte Verweigerung war eine Deadlock-Quelle: jede zählt als fehlgeschlagener Tool-Call, ein Modell das die Anweisung ignoriert verbrennt so das gesamte Fehlerbudget, ohne je einen Edit versucht zu haben. Das Sicherheitsnetz ist der Checkpoint pro Versuch, nicht eine Regel, die nur den Run beenden kann. |
| Guardrail nennt die echten Fehler | Statt nur „10x in Folge ohne Erfolg" jetzt die bis zu drei verschiedenen Fehlermeldungen der letzten Iteration — meist ist es derselbe eine Fehler. |

Der Backstop bleibt der Guardrail selbst: tool-unabhängig, und damit unfähig, einen Recovery-Pfad zu blockieren.

Regressionstests in [circuit-breaker-recovery.test.ts](packages/agent/test/circuit-breaker-recovery.test.ts) und [coding-token-efficiency.test.ts](packages/agent/test/coding-token-efficiency.test.ts).

---

## 10. Nachtrag: Plan-Schritte wurden im UI nicht abgehakt

**Symptom:** Der Coding-Plan bleibt optisch beim ersten Schritt stehen; nach Abschluss sind die Punkte nicht korrekt abgehakt.

### Ursache

Der Agent kennt den Status jedes Schritts sehr genau und sendet ihn auch: jedes `checklist`-Event trägt die **vollständige** Item-Liste mit `{ index, title, status }` plus `doneCount`/`total` (agent.ts, Phasen `created`/`progress`/`done`).

[CodingPlanPanel](apps/web/src/components/coding/CodingPlanPanel.tsx) hat diese Daten nie gelesen. Stattdessen schätzte es:

```ts
const eventsSincePlan = messages.slice(planIndex + 1)
  .filter(m => m.eventType === "tool_call" || m.eventType === "tool_result").length;
const doneCount = Math.min(eventsSincePlan, steps.length);
const done    = index < doneCount && !isLoading;
const running = index === doneCount && isLoading;
```

Daraus folgen beide Beobachtungen direkt:

- **`done` verlangte `!isLoading`.** Während der Ausführung konnte also *kein* Schritt als erledigt gezeichnet werden — sichtbar blieb ein einzelner Spinner. Solange nach der Plan-Ankündigung wenige Tool-Events lagen, stand der auf Schritt 1. Das ist das „bleibt immer beim ersten Punkt".
- **Nach dem Lauf** war „erledigt" = Anzahl Tool-Aufrufe, gedeckelt auf die Schrittzahl. Ein Lauf mit vielen Tool-Calls hakte *alle* Schritte ab, einer mit wenigen zu wenige — in keinem Fall korreliert mit dem tatsächlichen Ergebnis.

Zweiter, unabhängiger Fehler: Die Event-Typ-Whitelist beim Laden persistierter Nachrichten in [CodingWorkspace](apps/web/src/components/coding/CodingWorkspace.tsx) war eine abgedriftete Kopie der Chat-Variante und kannte `"checklist"` (sowie `"assistant_text"`) nicht. Nach einem Reload verlor der Status damit seinen Event-Typ und war auch für ein korrektes Panel nicht mehr auffindbar. Live-Events waren nicht betroffen — die reicht der Store unverändert durch.

### Behebung

Die Ableitung liegt jetzt in [lib/planChecklist.ts](apps/web/src/lib/planChecklist.ts) — als reine, testbare Funktionen statt inline in der Komponente, denn genau die Untestbarkeit hat den Fehler so lange überleben lassen:

- `findLatestChecklist()` — das jüngste `checklist`-Event ist die vollständige Wahrheit (kein Zusammenführen von Teilupdates).
- `resolveStepStatus()` — Zuordnung über `stepIndex`, Titel nur als Rückfalloption.
- `firstOpenStepIndex()` — der laufende Schritt ist der erste nicht-terminale. Aus den Status abgeleitet, nicht aus einem Zähler: ein fehlgeschlagener oder übersprungener Schritt verschiebt die Markierung sonst auf die falsche Zeile.

Die Anzeige unterscheidet jetzt `done`, `failed`, `unverified` und `skipped` statt nur „Haken oder nicht", und die Kopfzeile zeigt `x/y` **nur**, wenn es tatsächlich eine Checkliste gibt. Ohne Plan-Ausführung existiert kein Schritt-Status — dann wird keiner erfunden.

15 Regressionstests in [planChecklist.test.ts](apps/web/src/lib/planChecklist.test.ts), darunter die beiden konkreten Altfehler: „hakt während des Laufs ab, nicht erst danach" und „setzt Tool-Aktivität nicht mit erledigten Schritten gleich".
