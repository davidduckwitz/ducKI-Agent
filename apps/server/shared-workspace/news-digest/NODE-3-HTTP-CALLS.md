# Node 3: CoinGecko API - HTTP Operations Implementatio

n---

## CoinGecko News API Call

### Basis HTTP Requestn```javascriptn[TOOL:http({
  "method": "GET",
  "url": "https://api.coingecko.com/api/v3/news",
  "headers": {
    "Accept": "application/json",
    "User-Agent": "News-Digest-Bot/1.0"
  },
  "timeout": 15000
