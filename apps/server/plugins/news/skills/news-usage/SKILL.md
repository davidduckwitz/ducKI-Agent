---
name: news-usage
description: PRIMARY way to get nearly realtime news/current events. Use the `news` tool for ANY request about the news, latest headlines, "die neuesten/wichtigsten Nachrichten", a news digest, world/current events, or news about a country/topic (e.g. "was passiert in der Ukraine"). Always try the `news` tool FIRST — do not scrape sites with the browser tool for news unless the `news` tool cannot answer.
---

# News (daily digests, API-style)

**This is the primary news source for the agent.** Whenever the user wants news, headlines, a briefing, world events, or news on a topic/country, use the `news` tool — NOT the `browser`/web-scraping tool. Only fall back to the browser if the user needs a *specific* article/site the feeds don't cover, or explicitly asks to open a page.

The `news` tool fetches headlines from curated, keyless RSS/Atom feeds (plus any user-configured custom feeds) and stores one **Markdown digest per day and source** in the plugin's OWN SQLite database. It returns a full list in one call, persists it (so you can re-read it later), searches across many sources at once, and can geolocate stories.

**Quick recipe:** most "what's the news / what's happening" requests → `[TOOL:news({"action":"fetch","source":"all","count":10})]`. Topic/country → add `"query"`. "On a map" → `action:"map"`.

Every action is chosen via `action`. Results are consistent objects; article lists live in `articles` (`title`, `link`, `pubDate`, `summary`, `category`), and each digest also has a ready-to-save `markdown` field beginning with a dated `# Nachrichten – <source> – <YYYY-MM-DD>` heading.

**Category & sort:** every article is auto-classified into one category — `politik`, `wirtschaft`, `wissenschaft`, `sport`, `kultur`, `gesundheit`, `sonstiges` — from the feed's own `<category>` tags where present, else keyword-scored from title/summary. Pass `category` to `fetch`/`get`/`latest`/`map` to filter to one category (`"all"` or omitted = no filter). Pass `sort` to change ordering: `date` (default, newest first), `alert` (highest relevance/alert level first), `source` (A-Z), `category` (grouped alphabetically) — each with date as tie-breaker.

## Actions

- **fetch** — get today's digest. Fetches the network **at most once per day per source**; if today's digest already exists it returns the cached one (`cached: true`, no network). Pass `force: true` to refetch (manual refresh). **Multi-source:** pass `source: "all"` or `sources: ["tagesschau","bbc-world"]` to search across sources together — each source is stored separately (up to 30 each) and the returned `articles` are merged and sorted newest-first, each carrying its own `source`. `bySource` reports what was stored/cached per source.
  ```
  [TOOL:news({"action": "fetch", "source": "tagesschau", "count": 10})]
  [TOOL:news({"action": "fetch", "source": "all", "count": 15, "query": "ukraine"})]
  [TOOL:news({"action": "fetch", "sources": ["tagesschau","bbc-world"], "count": 12, "force": true})]
  ```
- **get** — read a stored digest by `date` (YYYY-MM-DD, default today) + `source`.
  ```
  [TOOL:news({"action": "get", "date": "2026-08-10", "source": "tagesschau"})]
  ```
- **latest** — the most recently stored digest (optionally for one `source`).
  ```
  [TOOL:news({"action": "latest", "count": 10})]
  ```
- **list** — metadata of all stored digests (`id`, `date`, `source`, `count`, `created_at`).
- **delete** — remove a digest by `id`, or by `date` + `source`.
- **map** — like `fetch`, but each returned article is geolocated via a built-in gazetteer (cities, countries, demonyms). Returns a `points` array `[{lat, lng, place, title, source, link, pubDate}]` for map display, plus `located` (how many were placed). Use for "show the news on a map" / location-based questions.
  ```
  [TOOL:news({"action": "map", "source": "all", "count": 40})]
  ```
- **sources** — the available source keys (`builtin`, `custom`, `default`).
- **layers** — geo layers for the map: static — `military_bases`, `nuclear_sites`, `undersea_cables`, `conflict_zones`, `chokepoints` (maritime straits/canals), `pipelines` (major oil/gas pipelines), `radiation_sources` (136 industrial gamma-irradiator facilities, IAEA DIIF), `major_ports` (25 largest container ports); live — `earthquakes` (USGS, past 24h, magnitude ≥ 4.5, keyless, fetched fresh each call; `earthquakesError` set if the live fetch failed).

## Custom sources
Users can add their own RSS/Atom feeds in the plugin settings (`custom_feeds` = JSON `{"key":"https://…"}`). Those keys then work everywhere a `source` is accepted. Only public `http(s)` hosts are allowed (localhost/private IPs are blocked). Built-in keys cannot be overridden.

## Parameters
`source`: `tagesschau` (DE) · `tagesschau-ausland` (DE world) · `bbc` (EN) · `bbc-world` (EN world) · `spiegel` (DE) · `dw` (EN) · `aljazeera` (EN) · `guardian-world` (EN) · `nyt-world` (EN) · `euronews` (EN) · `sky-world` (EN) · `ntv` (DE) · `zeit` (DE) · `deutschlandfunk` (DE) · `france24` (EN) · `africanews` (EN) · `abc-au` (EN, Australia) · `global-news-ca` (EN, Canada) · `mercopress` (EN, South America). Omitted → the plugin's configured default. `count`: 1–30 (default 10). `query`: case-insensitive filter over title + summary (applied to the returned list; the full day is still stored).

## Location matching (for `map`)
Each article's title + summary is scored against a gazetteer (cities, countries, demonyms/nationality adjectives) using word-boundary matching, with title hits weighted 3x over summary hits and the most-mentioned/most-specific match (city beats country) winning — not just the first substring found. This reduces mis-assignment when a country is only mentioned in passing but a city is the actual focus.

## Guidance
- When the user asks for **N** items (e.g. "die 10 wichtigsten"), pass `count: N` and report N — the feed holds up to 30, so don't stop short.
- To **save/hand over** the news, use the digest's `markdown` field (already dated) — e.g. write it to the workspace with the filesystem tool if the user wants a file.
- Respect the daily cache: for the same day/source reuse `fetch`/`get`/`latest` (no network). Only use `force: true` when the user explicitly wants fresh data.
- All failures come back as an `error` field (never a crash); if a refetch fails but a cached digest exists, the tool returns the cache with a `warning`.
