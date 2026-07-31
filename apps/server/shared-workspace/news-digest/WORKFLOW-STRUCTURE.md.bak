# News-Digest-Automation Workflow

**Workflow-ID:** `wf_f1w6kcc2_1785468154727`n**Status:** Activen**Erstellt:** 31. Juli 2026, 05:20 CEST

---

## Aktivierte Skills (Pi

ed)

- ✅ **http-operations** (pi

ed)n- ✅ **tool-orchestration** (pi

ed)n- ✅ **json-tool-format**n- ✅ **shared-workspace-ops**

---

## Node-Struktur (8 Nodes)

### Node 1: Daily Trigger (06:00 CEST)

**Typ:** Cronjobn**Skill:** cronjobsn**Schedule:** `0 6 * * *` (täglich 06:00 CEST)n**Timezone:** Europe/Berli

**Position:** (100, 100)n**Abhängigkeiten:** Keinen**Nächster Start:** 01. August 2026, 06:00 CEST

**Funktion:** Startet täglich um 06:00 CEST den gesamten Workflow

**Tool-Aufruf:**n```n[TOOL:cronjob({"action": "create", "schedule": "0 6 * * *", "targetType": "workflow", "targetRef": "wf_f1w6kcc2_1785468154727", "timezone": "Europe/Berlin"})]n```

---

### Node 2: BBC News - Krieg & Konflikte

**Typ:** Browser Scrapern**Skill:** browser-controln**URL:** `https://www.bbc.com/news`n**Position:** (100, 250)n**Abhängigkeiten:** Node 1n**Timeout:** 30 Sekunde

**Headless Mode:** true

**Suchbegriffe:**n- warn- conflictn- ukrainen- militaryn- crisisn- geopolitical

**Funktion:** Scraped BBC News Website für aktuelle Artikel zu Krieg und Konflikte

n**Tool-Aufruf (Sequenz):**n```n[TOOL:browser({"action": "launch", "headless": true})]n[TOOL:browser({"action": "goto", "sessionId": "browser_session", "url": "https://www.bbc.com/news", "timeout": 30})]n[TOOL:browser({"action": "screenshot", "sessionId": "browser_session"})]n[TOOL:browser({"action": "evaluate", "sessionId": "browser_session", "script": "() => Array.from(document.querySelectorAll('article')).map(el => ({title: el.querySelector('h2, h3')?.textContent, url: el.querySelector('a')?.href, summary: el.querySelector('p')?.textContent, timestamp: new Date().toISOString()}))"})]n[TOOL:browser({"action": "close", "sessionId": "browser_session"})]n```

**Output Format:**n```jso

[
  {
    "title": "string",
    "url": "string",
    "summary": "string",
    "timestamp": "ISO8601",
    "source": "BBC News"
