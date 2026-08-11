# Session-Checkliste — Design- & Implementierungsplan

> Ziel: Das Abarbeiten von Aufträgen stabilisieren, indem der Agent pro Chat-Session
> eine persistente, Verifier-gekoppelte Checkliste führt, den nächsten offenen Schritt
> pro Iteration fokussiert, und den Lauf erst beendet, wenn alle Schritte verifiziert
> sind (oder ein Limit greift). Die Checkliste ist im Chat sichtbar (done/offen/unbestätigt).

Status: **Design abgeschlossen, Implementierung ausstehend.**

---

## 1. Ausgangslage — wie der Agent heute arbeitet

Kern-Loop: [`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts) → `run()` (Z. 516) → `runLoop()` (Z. 4207).

1. **Pre-Flight-Tools** (Z. 549): Ground-Truth (Zeit/Datum/Status) vor der LLM-Inferenz, gegen Halluzination.
2. **Optionales Planen**: `Planner` / `plan`-Tool ([`planner/plan-tool.ts`](../packages/agent/src/planner/plan-tool.ts)) erzeugt einen strukturierten Plan. **Ephemer** — als Markdown ins UI-Panel emittet, aber nicht als persistierter, abhakbarer Zustand geführt.
3. **Iterations-Loop** (Z. 4936): `while (iterations < maxIterations)` (Default 50). Pro Iteration: Memory-Kontext → LLM-Antwort → Tool-Calls ausführen → Ergebnisse zurück in die Conversation.
4. **Terminierung** (Z. 5560): Loop endet, sobald das LLM eine Antwort **ohne** Tool-Calls liefert (implizites „fertig"), oder bei Iterations-/Timeout-Limit.
5. **Qualitäts-Pässe danach**: `Reflection` (Fuzzy-Score) und `Verifier` (Constraint-Checkliste, [`verification/verifier.ts`](../packages/agent/src/verification/verifier.ts)) laufen **erst nach** der finalen Antwort, mit begrenzten Fix-Attempts (Default 1) — Verify-Fix-Schleife bei Z. 5762.

### Schwachstellen
- **Kein persistenter Ziel-Zustand.** Offene Teilziele leben nur implizit im Kontextfenster → gehen bei Kompression/langem Lauf verloren (Drift, Doppelarbeit).
- **Vorzeitiges „fertig".** Loop endet bei „keine Tool-Calls", auch wenn Teilziele offen sind. Verify prüft erst danach, nur 1 Fix-Versuch.
- **Kein Selbst-Check *während* der Arbeit**, nur am Ende.

---

## 2. Getroffene Entscheidungen

| Thema | Entscheidung |
|---|---|
| Storage | **Neue Tabelle `session_checklist` in der zentralen DB** (nicht eigene SQLite-Datei) |
| Abhaken | **Verifier-gekoppelt** — done nur bei bestandener Constraint |
| Trigger | **Nur ab Komplexität `medium`/`high`** (Planner-Einschätzung) |
| Loop-Eingriff | **Voll** — Zustand + Injektion des nächsten Schritts + Terminierung |
| Skipped-Policy | **`soft` als Default** (nicht-blockierend, sichtbar), `strict` optional |
| UI | **Inline-Checklist-Panel im Chat** mit done/offen/unbestätigt + Toggle |

### Warum keine eigene SQLite-DB
Die zentrale DB ist **engine-agnostisch** ([`database-factory.ts`](../packages/database/src/database-factory.ts): SQLite *oder* MySQL/MariaDB je `DATABASE_URL`). Eine separate SQLite-Datei würde:
- den Engine-Vertrag brechen (kein einheitliches Backup/Transaktions-Modell bei MySQL),
- eine **zweite Wahrheit** schaffen (Drift Checkliste ↔ Conversation — genau das Problem, das die Checkliste lösen soll).

Separate DBs sind nur zur **Isolation** gerechtfertigt (wie per-Plugin-SQLite in [`plugin-storage.ts`](../packages/database/src/plugin-storage.ts)). Die Session-Checkliste ist Kernzustand, kein isolierter Sandkasten.

---

## 3. Datenmodell — neue Tabelle in [`schema.ts`](../packages/database/src/schema.ts)

```ts
export const sessionChecklist = sqliteTable("session_checklist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").references(() => conversations.id).notNull(),
  runId: text("run_id"),                       // ein Run kann die Checkliste neu aufsetzen (Re-Plan)
  stepIndex: integer("step_index").notNull(),  // Reihenfolge (= Planner-Schritt)
  title: text("title").notNull(),
  description: text("description"),
  constraint: text("constraint"),              // die verifizierbare Acceptance-Criteria
  constraintKind: text("constraint_kind"),     // requirement|logic-assertion|style|shell-check|unit-test
  status: text("status").notNull().default("pending"), // pending|in_progress|done|failed|unverified|skipped
  confidence: text("confidence"),              // verified|soft (bei done)
  verifyState: text("verify_state"),           // JSON: letzter VerifyResult-Auszug
  attempts: integer("attempts").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
```

Warum neue Tabelle statt `tasks`-Reuse: `tasks` hängt an `projects` und wird bereits von task-split/workflow/tools mit `createdBy`-Tags befüllt. Eine dedizierte Tabelle bleibt sauber abfragbar (`WHERE conversationId=? AND runId=?`) ohne Fremd-Semantik.

**CRUD in [`index.ts`](../packages/database/src/index.ts)** (bewusst schmal):
`createChecklist(convId, runId, items[])`, `getChecklist(convId, runId)`, `updateChecklistItem(id, patch)`, `getOpenItems(convId, runId)`.

---

## 4. Neues Modul `packages/agent/src/checklist/checklist-manager.ts`

Kapselt die Logik, damit `agent.ts` (bereits ~6000 Z.) nur dünne Aufrufe erhält.

- `deriveFromPlan(plan): ChecklistItem[]` — mappt `plan.steps` → Items; erzeugt pro Schritt eine **verifizierbare Constraint** (nutzt `Verifier.deriveConstraints` pro Schritt, nicht nur global). Klassifiziert Constraint-Art (siehe §5).
- `nextOpen()` / `allSatisfied()` — Zustandsabfrage für den Loop.
- `markInProgress(id)`.
- `verifyAndMark(id, evidence, verifier)` — Verifier-gekoppeltes Abhaken (siehe §5).
- `renderMarkdown()` — Snapshot für UI-Event und optional als `checklist.md` im Scoped-Workspace (Lese-Ansicht, keine Wahrheit).

---

## 5. Verifier-Kopplung & „skipped"-Semantik (Kern-Design)

### Check-Arten (Ist-Zustand, [`verify-types.ts`](../packages/agent/src/verification/verify-types.ts))
- `requirement` / `logic-assertion` / `style` → **LLM-geprüft** (`runLlmChecks`) → echtes `passed`/`failed`.
- `shell-check` / `unit-test` → **Executable** → `skipped`, wenn kein Shell-Executor.

**Wichtig:** Nicht-Code-Tasks sind LLM-verifizierbar. „skipped" entsteht bei Nicht-Code **nicht** durch fehlenden Executor, sondern nur bei:
1. Ganzer Verify-Call scheitert (Netz/Parse) → alle Checks `skipped` ([verifier.ts:208](../packages/agent/src/verification/verifier.ts)).
2. LLM lässt eine `id` weg → dieser Check `skipped` ([verifier.ts:190](../packages/agent/src/verification/verifier.ts)).
3. Fälschlich ein `shell-check` für einen Nicht-Code-Schritt.

### Design-Konsequenz 1 — Constraint-Art beim Ableiten festlegen
`deriveFromPlan` wählt die Art anhand `plan.planType`/Tools:
- **Coding-Schritt** (Datei-/Test-/Build-Tools): `shell-check`/`unit-test` bevorzugen (harte Evidenz), Fallback `requirement`.
- **Nicht-Code-Schritt**: **immer** LLM-prüfbar (`requirement`/`logic-assertion`), **nie** `shell-check` → Fall 3 by-design ausgeschlossen.

### Design-Konsequenz 2 — Evidenz-Quelle
Ein Zwischenschritt lässt sich nicht am Prosa-Text prüfen; die Evidenz steckt in den **Tool-Ergebnissen**. `verifyAndMark` erhält daher eine kompilierte **Evidenz-Zeichenkette** = letzte Assistant-Texte **+ Tool-Results** im Fenster des Schritts, nicht nur `finalResponse`.

### Design-Konsequenz 3 — Item-Status-Ableitung mit Konfidenz

| Check-Ergebnis der Item-Constraint(s) | Item-Status | Konfidenz | Loop-Wirkung |
|---|---|---|---|
| mind. 1 non-skipped `passed`, kein `failed` | `done` | **verified** | nächster Schritt |
| irgendein `failed` | `failed` | — | Reparatur bis `maxItemAttempts`, dann `skipped` |
| **alle** Checks `skipped` (Fall 1/2) | `unverified` | **soft** | siehe Policy |

Neuer Status `unverified` (getrennt von `failed`), damit UI „nicht hart bestätigt" von „geprüft & durchgefallen" unterscheidet.

### Design-Konsequenz 4 — Policy gegen Hänger (`AGENT_CHECKLIST_SKIPPED_POLICY`)
- **`soft` (Default):** `unverified` blockiert die Terminierung nicht. 1× Retry des Verify-Calls (deckt transiente Fall-1-Fehler); bleibt es `skipped`, wird der Punkt als `done` mit Badge **„unbestätigt"** geführt und im Report gelistet.
- **`strict`:** `unverified` blockiert wie `failed` bis `maxItemAttempts`, danach automatischer Downgrade auf `soft` (harte Anti-Infinite-Loop-Grenze).

---

## 6. Integration in [`agent.ts`](../packages/agent/src/agent.ts) `runLoop`

**a) Aufbau** (nach Plan-Erzeugung, vor `while` bei Z. 4936):
```
wenn plan?.estimatedComplexity ∈ {medium, high} und Feature-Flag an:
    checklist = await checklistManager.deriveFromPlan(plan)
    persist + emit("checklist", …, { phase: "created" })
```
Bei low/trivial: keine Checkliste → Loop unverändert (kein Overhead).

**b) Injektion pro Iteration** (bei Prompt-Bildung ~Z. 4946, analog zum dynamischen Memory-Kontext):
```
if (checklist aktiv) {
  const open = checklist.nextOpen();
  systemHint += "AKTUELLER SCHRITT: " + open.title
              + "\nAkzeptanzkriterium: " + open.constraint
              + "\nOffen: " + openCount + "/" + total;
}
```

**c) Verifier-Kopplung + Terminierungs-Change** (Ersatz für Z. 5560–5564):
```
if (toolResultsMap.size === 0) {
   if (checklist aktiv && !checklist.allSatisfied()) {
       const open = checklist.nextOpen();
       const evidence = compileEvidence(recentAssistantText, recentToolResults);
       const vr = await checklistManager.verifyAndMark(open.id, evidence, this.verifier);
       emit("checklist", …, { phase: "progress", item: open.title, status: vr.itemStatus });
       if (vr.itemStatus === "done") continue;          // bestätigt → nächster Schritt
       if (open.attempts >= maxItemAttempts) { checklist.skip(open.id); continue; }
       // sonst Reparatur-Prompt injizieren (analog Verify-Fix bei Z. 5805) und weiter
       continue;
   }
   break; // alles erledigt ODER keine Checkliste → wie bisher
}
```

**d) Abschlussreport:** Beim finalen `return` Reststatus anhängen — bei Limit mit offenen Punkten „Erledigt: 4/6. Offen: …" statt falschem „fertig". Post-Loop-Verify (Z. 5762) bleibt als globaler Schluss-Check.

---

## 7. Chat-UI — Checkliste anzeigen (done/offen/unbestätigt)

Referenz/Wiederverwendung: [`PlanExecutionPanel.tsx`](../apps/web/src/components/chat/PlanExecutionPanel.tsx) rendert bereits `pending/in_progress/completed/failed` mit Icon+Badge+Farbe (Z. 85–137) — ist aber ein Modal. Für die laufende Checkliste: **inline, mitlaufend**.

### Verdrahtung
1. **Event-Typ** `checklist` in die Union [`chatTypes.ts:1`](../apps/web/src/components/chat/chatTypes.ts) **und** in die beiden `type === …`-Whitelists in [`ChatContainer.tsx:494`](../apps/web/src/components/chat/ChatContainer.tsx) & Z. 622 (sonst herausgefiltert).
2. **Payload** (analog `PlanEventPayload`): `{ phase: "created"|"progress"|"done", items: [{ index, title, status, confidence?, detail? }], doneCount, total }`.
3. **Live-Status im Store:** `checklistItems`-State analog zum vorhandenen `stepStatuses`-Record ([ChatContainer.tsx:148](../apps/web/src/components/chat/ChatContainer.tsx)), Merge bei jedem `checklist`-Event. Strukturierte Items → kein Markdown-Re-Parsing.

### UI-Verhalten
- **Einklappbares Inline-Panel** oben in der laufenden Assistant-Antwort: „Schritte 3/6 erledigt" + aufklappbare Liste.
- **Zustände pro Punkt:** ✅ `done` (grün) · ✅ + gelbes Badge „unbestätigt" (`unverified`) · ⏳ `in_progress` (Spinner + DuckyMascot) · ⚠️ `failed` (rot) · ⚪ `pending`.
- **Toggle „Checkliste anzeigen/ausblenden"** in der Kopfzeile; Default eingeklappt bei ≤3 Schritten.
- **Replay:** Alte Conversation → Checkliste aus DB (`getChecklist`) rekonstruiert, gleiches Panel im Endzustand.

### Frontend-Dateien
- `apps/web/src/components/chat/ChecklistView.tsx` (neu, geteiltes Step-Rendering inkl. „unverified"-Badge)
- `ChatContainer.tsx` (State + Event-Handling + Whitelists)
- `chatTypes.ts` (`checklist` in Union)
- optional `eventMeta.tsx` (Icon/Label)

---

## 8. Konfig-Flags (analog `AGENT_*` in [agent.ts:3197](../packages/agent/src/agent.ts))

| Flag / Setting | Default | Wirkung |
|---|---|---|
| `AGENT_CHECKLIST_ENABLED` | `false` | Feature an/aus |
| `AGENT_CHECKLIST_MIN_COMPLEXITY` | `medium` | Trigger-Schwelle (low/medium/high) |
| `AGENT_CHECKLIST_MAX_ITEM_ATTEMPTS` | `2` | Reparaturversuche pro Punkt (1-5) |
| `AGENT_CHECKLIST_SKIPPED_POLICY` | `soft` | `soft` \| `strict` |

Alle vier sind **DB-Settings**, editierbar auf **Settings → Agent → „Session-Checkliste"**
(gerendert aus `PREDEFINED_FIELDS` in [Settings.tsx](../apps/web/src/components/settings/Settings.tsx) + Gruppe in [settingsGroups.ts](../apps/web/src/components/settings/settingsGroups.ts)); der Agent liest sie über `loadRuntimeControls` → `AgentRuntimeControls` (nicht mehr aus `process.env`). Voll rückschaltbar → risikoarmes Rollout.

---

## 9. Fehlermodi & Gegenmaßnahmen

| Risiko | Gegenmaßnahme |
|---|---|
| Endlosschleife an nie erfüllbarem Punkt | `maxItemAttempts` → `skipped` + Report; globales `maxIterations`/Timeout unberührt |
| Verify liefert nur `skipped` (transient) | 1× Retry, dann `unverified` + soft (nicht blockierend) |
| Token-Kosten durch per-Item-Verify | nur ab medium/high; Constraints 1× beim Aufbau abgeleitet |
| Drift Checkliste ↔ Conversation | eine DB, Transaktion pro Item-Update; Markdown nur Projektion |
| Plan ändert sich mittendrin | `runId` versioniert die Checkliste; Re-Plan legt neuen Satz an |
| Nicht-Code-Schritt „am Text" fälschlich failed | Evidenz = Tool-Results + Assistant-Text, nicht nur Prosa |

---

## 10. Phasen & Tests

1. **P1 — Persistenz:** Tabelle + CRUD + Unit-Tests. Kein Verhaltens-Change. ✅ **erledigt** (2026-08-10): `session_checklist`-Tabelle in [schema.ts](../packages/database/src/schema.ts) + Migration + CRUD (`createChecklist`/`getChecklist`/`getOpenChecklistItems`/`updateChecklistItem`/`deleteChecklist`) in [index.ts](../packages/database/src/index.ts); 8 Tests grün in [session-checklist.test.ts](../packages/database/src/session-checklist.test.ts). Hinweis: Spalte heißt `acceptance_criteria` statt `constraint` (reserviertes SQL-Keyword).
2. **P2 — Manager:** `checklist-manager.ts` + `deriveFromPlan` + `verifyAndMark` + Markdown-Render. ✅ **erledigt** (2026-08-10): [checklist-manager.ts](../packages/agent/src/checklist/checklist-manager.ts) mit `ChecklistManager` (deriveFromPlan/nextOpen/allSatisfied/markInProgress/verifyAndMark/skip/renderMarkdown) + puren Helfern (`pickConstraintKind` — nie shell-check für general steps; `deriveAcceptanceCriteria`; `deriveItemStatus` — Mapping auf done/failed/unverified). Verifier-Fehler werden als `unverified` abgefangen. 13 Tests grün in [checklist-manager.test.ts](../packages/agent/src/checklist/checklist-manager.test.ts) mit Fake-Store + gemocktem Verifier. Noch nicht in den runLoop verdrahtet (Phase 3/4).
3. **P3 — Loop-Injektion:** Fokus-Hint pro Iteration. ✅ **erledigt** (2026-08-10): `checklistHint` (aktueller Schritt + Akzeptanzkriterium + vorheriger Fehler) wird pro Iteration in die System-Message injiziert; `getChecklistConfig`/`meetsMinComplexity`/`compileChecklistEvidence`/`extractChecklistFailure` in [agent.ts](../packages/agent/src/agent.ts). Ableitung aus `planContext` nach der plan-Emission. Feature default **OFF** (`AGENT_CHECKLIST_ENABLED`).
4. **P4 — Terminierungs-Change:** Verifier-gekoppelter Exit. ✅ **erledigt** (2026-08-10): Ersatz des `toolResultsMap.size === 0`-Break in [agent.ts](../packages/agent/src/agent.ts) — offener Schritt wird gegen Evidenz verifiziert, done→weiter, unverified+soft→akzeptiert, failed/strict→Retry bis `maxItemAttempts` dann skip. Abschlussreport hängt offene/unbestätigte Punkte an `finalResponse`. 277 Agent-Tests grün, tsc sauber.
5. **P5 — UI-Panel + Report:** ✅ **erledigt** (2026-08-10): [ChecklistView.tsx](../apps/web/src/components/chat/ChecklistView.tsx) rendert Schritte mit done/offen/unbestätigt/übersprungen/fehler; `checklist`-Event in [chatTypes.ts](../apps/web/src/components/chat/chatTypes.ts) + Whitelists in [ChatContainer.tsx](../apps/web/src/components/chat/ChatContainer.tsx) + Icon/Label/Tone in [eventMeta.tsx](../apps/web/src/components/chat/eventMeta.tsx) + Sonderrendering in [ChatMessageRow.tsx](../apps/web/src/components/chat/ChatMessageRow.tsx). Jedes Event trägt vollen Items-Snapshot → korrekt live **und** im Replay. tsc + vite build grün. **Default-on für medium/high steht noch aus** (bewusst: Flag bleibt OFF bis Praxistest).

### Erfolgsmessung
Baseline vs. Checkliste auf festem Multi-Step-Prompt-Set über vorhandene Signale
(`reflectionQuality`, `verifyResult.passed`, `repeatedToolCalls`-Map bei [agent.ts:4917](../packages/agent/src/agent.ts)).
Erwartet: weniger „vorzeitig fertig", höhere Verify-Pass-Rate, weniger Doppel-Tool-Calls.

---

## 11. Berührte Dateien (Übersicht)

**Backend**
- `packages/database/src/schema.ts` — neue Tabelle
- `packages/database/src/index.ts` — CRUD
- `packages/agent/src/checklist/checklist-manager.ts` — **neu**
- `packages/agent/src/agent.ts` — Aufbau/Injektion/Terminierung (Z. ~4936, ~4946, ~5560)
- `packages/agent/src/verification/verifier.ts` — ggf. `verifyItem`-Hilfe für Item-Konfidenz

**Frontend**
- `apps/web/src/components/chat/ChecklistView.tsx` — **neu**
- `apps/web/src/components/chat/ChatContainer.tsx` — State/Events/Whitelists
- `apps/web/src/components/chat/chatTypes.ts` — Event-Union
- `apps/web/src/components/chat/eventMeta.tsx` — optional
