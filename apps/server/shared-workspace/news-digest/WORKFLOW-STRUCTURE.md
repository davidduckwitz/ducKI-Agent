# News-Digest Workflow-Struktur

## Node 1: CoinGecko News API
- URL: https://api.coingecko.com/api/v3/news
- Methode: GET
- Output: JSON mit News-Array

## Node 2: Filter & Deduplizierung
- Entfernt Duplikate
- Filtert nach Kategorie
- Output: Bereinigtes Array

## Node 3: HTTP-Calls Orchestrierung
- Parallel HTTP-Requests
- Rate-Limiting beachte

- Fehlerbehandlung

## Node 4: Sentiment-Analyse
- Text-Processing
- Score 0-100
- Kategorisierung

## Node 5: Daten-Aggregatio

- Kombiniert alle Quelle

- Formatiert Output

## Node 6: Template-Rendering
- Markdown-Generatio

- Discord-Format

## Node 7: Speicherung
- Datei-Export
- Metadate


## Node 8: Notificatio

- Discord-Versand
- Status-Update
