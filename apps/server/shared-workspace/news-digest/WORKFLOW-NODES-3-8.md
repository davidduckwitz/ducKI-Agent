# News-Digest Workflow: Nodes 3-8

---

## Node 3: CoinGecko API - Bitcoin & Krypto

**Typ:** HTTP Requestn**Skill:** http-operations (pi

ed)n**Methode:** GETn**URL:** `https://api.coingecko.com/api/v3/news`n**Position:** (300, 250)n**Abhängigkeiten:** Node 1n**Timeout:** 15 Sekunde

n**Suchbegriffe:**n- bitcoi

- btcn- crypton- ethereumn- blockchai

- defin- altcoi

n**Funktion:** Holt aktuelle Bitcoin und Krypto-News von der CoinGecko API

**Tool-Aufruf:**n```n[TOOL:http({"method": "GET", "url": "https://api.coingecko.com/api/v3/news", "headers": {"Accept": "application/json"}})]n```

**Output Format:**n```jso

{
  "data": [
    {
      "title": "string",
      "description": "string",
      "url": "string",
      "image_url": "string",
      "updated_at": "ISO8601",
      "source": "CoinGecko"
    }
  ]
}n```

---

## Node 4: Filter & De-Duplikate

**Typ:** Data Processorn**Skill:** tool-orchestration (pi

ed)n**Position:** (200, 400)n**Abhängigkeiten:** Node 2, Node 3 (parallel merge)n**Timeout:** 10 Sekunde

n**Konfiguration:**n- Remove Duplicates: truen- Min Relevance Score: 0.7n- Sort By: timestamp (descending)n- Max Article Age: 1440 Minuten (24 Stunde
)n- Keep Top N Articles: 20

**Funktion:** Kombiniert News aus BBC und CoinGecko, entfernt Duplikate, filtert nach Relevanz

**Algorithmus:**n1. Merge arrays from node 2 and node 3n2. Remove duplicates (fuzzy matching on title)n3. Filter by relevance score > 0.7n4. Sort by timestamp descendingn5. Keep only articles from last 24 hoursn6. Limit to top 20 most relevant

**Output Format:**n```jso

{
  "articles": [
    {
      "title": "string",
      "url": "string",
      "summary": "string",
      "source": "BBC News | CoinGecko",
      "category": "War & Conflict | Bitcoin & Crypto",
      "timestamp": "ISO8601",
      "relevance_score": 0.85
    }
  ],
  "stats": {
    "total_before_filter": 45,
    "duplicates_removed": 8,
    "after_filter": 20,
    "war_articles": 12,
    "crypto_articles": 8
  }
