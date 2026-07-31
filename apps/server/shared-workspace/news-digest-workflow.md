# News-Digest-Automation Workflow

**Workflow-ID:** `wf_f1w6kcc2_1785468154727`n**Status:** Activen**Erstellt:** 31. Juli 2026, 05:20 CEST

---

## 📋 Workflow-Übersicht

Täglich automatisierter News-Digest mit 8 einzelnen Nodes, die nachgestellt werden kö

en.

---

## 🔄 Nodes im Detail

### Node 1: Daily Trigger (06:00 CEST)n```jso

{
  "id": "node_1",
  "title": "Daily Trigger (06:00 CEST)",
  "type": "cronjob",
  "schedule": "0 6 * * *",
  "timezone": "Europe/Berlin",
  "nextRun": "2026-08-01T06:00:00+02:00",
  "enabled": true
}n```n**Funktion:** Startet täglich um 06:00 CEST den gesamten Workflown**Abhängigkeiten:** Keinen**Nächster Start:** 01. August 2026, 06:00 CEST

---

### Node 2: BBC News - Krieg & Konflikten```jso

{
  "id": "node_2",
  "title": "BBC News - Krieg & Konflikte",
  "type": "browser",
  "url": "https://www.bbc.com/news",
  "selectors": [
    "article h2",
    "article h3",
    "[data-testid='internal-link']"
  ],
  "keywords": ["war", "conflict", "ukraine", "middle east", "military"],
  "timeout": 30,
  "headless": true,
  "dependsOn": ["node_1"]
