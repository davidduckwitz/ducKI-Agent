---
name: news-usage
description: How to fetch, store, and retrieve current headlines with the news tool. Use whenever the user asks for the news, latest headlines, "die neuesten Nachrichten", a news digest, news about a topic, or to re-read earlier news — instead of scraping a website with the browser tool.
---

# News (daily digests, API-style)

The `news` tool fetches headlines from curated, keyless RSS feeds and stores one **Markdown digest per day and source** in the plugin's OWN SQLite database. Prefer it over the `browser` tool: it returns a full list in one call and persists it, so you can re-read it later.

Every action is chosen via `action`. Results are consistent objects; article lists live in `articles` (`title`, `link`, `pubDate`, `summary`), and each digest also has a ready-to-save `markdown` field beginning with a dated `# Nachrichten – <source> – <YYYY-MM-DD>` heading.

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
- **sources** — the available source keys.

## Parameters
`source`: `tagesschau` (DE) · `tagesschau-ausland` (DE world) · `bbc` (EN) · `bbc-world` (EN world) · `spiegel` (DE). Omitted → the plugin's configured default. `count`: 1–30 (default 10). `query`: case-insensitive filter over title + summary (applied to the returned list; the full day is still stored).

## Guidance
- When the user asks for **N** items (e.g. "die 10 wichtigsten"), pass `count: N` and report N — the feed holds up to 30, so don't stop short.
- To **save/hand over** the news, use the digest's `markdown` field (already dated) — e.g. write it to the workspace with the filesystem tool if the user wants a file.
- Respect the daily cache: for the same day/source reuse `fetch`/`get`/`latest` (no network). Only use `force: true` when the user explicitly wants fresh data.
- All failures come back as an `error` field (never a crash); if a refetch fails but a cached digest exists, the tool returns the cache with a `warning`.
