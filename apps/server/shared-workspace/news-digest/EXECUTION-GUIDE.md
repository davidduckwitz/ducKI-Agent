# News-Digest Workflow - Ausführungsanleitung

**Workflow-ID:** `wf_f1w6kcc2_1785468154727`n**Skills aktiviert:** http-operations (pi

ed), tool-orchestration (pi

ed), json-tool-format, shared-workspace-ops

---

## 🚀 Schnellstart

### Automatische Ausführung (produktiv)n```bashn# Workflow startet täglich um 06:00 CEST automatisch via Cronjobn# Keine manuelle Intervention nötign```

### Manuelle Ausführung (Test/Debug)n```bashn# Starte Workflow manuelln[TOOL:workflow({"action": "run", "id": "wf_f1w6kcc2_1785468154727"})]n```

---

## 📋 Vollständige Node-Ausführungsreihenfolge

### Phase 1: Triggern```nNode 1: Daily Trigger (06:00 CEST)n├─ Schedule: 0 6 * * * Europe/Berli

├─ Action: Start Workflown└─ Output: Workflow Start Signaln```

### Phase 2: Parallel News Collection (parallel executio
)n```nNode 2 (parallel)         Node 3 (parallel)n├─ BBC News Scrape       ├─ CoinGecko APIn│  ├─ URL: bbc.com/news  │  ├─ URL: api.coingecko.com/newsn│  ├─ Keywords: war      │  ├─ Keywords: bitcoin, crypton│  ├─ Timeout: 30s       │  ├─ Timeout: 15sn│  └─ Output: 20-30      │  └─ Output: 30-50n│     articles            │     articlesn└─ Wait for completio
    └─ Wait for completio

```

### Phase 3: Processingn```nNode 4: Filter & De-Duplikaten├─ Input: Node 2 + Node 3 results (merged)n├─ Actions:n│  ├─ Remove duplicates (fuzzy match)n│  ├─ Filter by relevance > 0.7n│  ├─ Keep only 24h old articlesn│  ├─ Sort by timestamp descn│  └─ Limit to top 20n└─ Output: 15-20 filtered articlesn```

### Phase 4: Formattingn```nNode 5: Markdown Digestn├─ Input: Filtered articles from Node 4n├─ Format: Markdown with sectionsn│  ├─ Header + metadatan│  ├─ War & Conflicts sectio

│  ├─ Bitcoin & Crypto sectio

│  └─ Footer + statsn└─ Output: Formatted .md contentn```

### Phase 5: Storagen```nNode 6: Save to shared-workspacen├─ Path: ./shared-workspace/news-digest/{DATE