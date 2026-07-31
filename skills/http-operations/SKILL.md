# Skill: HTTP Operations

## Zusammenfassung
Sichere und effektive HTTP-Requests und API-Calls. APIs anrufen, Daten holen, externe Services integrieren - alles mit Best Practices für Sicherheit, Performance und Error Handling.

## Kernfunktionen

### 1. GET Request (Daten holen)
```
[TOOL:http({
  "method": "GET",
  "url": "https://api.example.com/users/123"
})]
```

**Wann nutzen:**
- Daten von APIs abrufen
- Externe Services abfragen
- Status überprüfen
- Öffentliche Daten laden

**Mit Query-Parameters:**
```
[TOOL:http({
  "method": "GET",
  "url": "https://api.example.com/search?q=nodejs&limit=10"
})]
```

**Mit Headers:**
```
[TOOL:http({
  "method": "GET",
  "url": "https://api.example.com/data",
  "headers": {
    "Authorization": "Bearer YOUR_TOKEN",
    "Accept": "application/json"
  }
})]
```

### 2. POST Request (Daten senden)
```
[TOOL:http({
  "method": "POST",
  "url": "https://api.example.com/users",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer TOKEN"
  },
  "body": {
    "name": "John Doe",
    "email": "john@example.com"
  }
})]
```

**Wann nutzen:**
- Neue Daten erstellen
- Formulare absenden
- API-Commands ausführen
- Daten speichern

⚠️ **WICHTIG:**
- Content-Type Header setzen!
- Authorization Token immer verwenden (wenn nötig)
- Body muss valid JSON sein
- Secrets NICHT in URLs packen!

### 3. PUT Request (Daten aktualisieren)
```
[TOOL:http({
  "method": "PUT",
  "url": "https://api.example.com/users/123",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer TOKEN"
  },
  "body": {
    "name": "Jane Doe",
    "email": "jane@example.com"
  }
})]
```

**Wann nutzen:**
- Gesamte Ressource aktualisieren
- Komplette Daten ersetzen
- Nicht für Partial Updates verwenden (nutze PATCH)

### 4. PATCH Request (Partial Update)
```
[TOOL:http({
  "method": "PATCH",
  "url": "https://api.example.com/users/123",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer TOKEN"
  },
  "body": {
    "email": "newemail@example.com"
  }
})]
```

**Wann nutzen:**
- Nur einzelne Felder aktualisieren
- Effizient (kleiner payload)
- Bestehende Daten nicht verlieren

**PUT vs PATCH:**
```
PUT:   Ersetze ALLES mit: {"name":"Jane", "email":"jane@ex.com"}
PATCH: Ändere nur: {"email":"jane@example.com"} (name bleibt!)
```

### 5. DELETE Request (Daten löschen)
```
[TOOL:http({
  "method": "DELETE",
  "url": "https://api.example.com/users/123",
  "headers": {
    "Authorization": "Bearer TOKEN"
  }
})]
```

**Wann nutzen:**
- Ressourcen löschen
- Daten aufräumen
- Benutzer deaktivieren

⚠️ **VORSICHT:**
- Löschen ist PERMANENT
- Immer Existenz überprüfen vor DELETE
- Auth-Token korrekt?

### 6. Error Handling
```
[TOOL:http({
  "method": "GET",
  "url": "https://api.example.com/data",
  "headers": {
    "Authorization": "Bearer TOKEN"
  }
})]
// Response überprüfen:
// ✅ 200 OK
// ✅ 201 Created
// ❌ 400 Bad Request
// ❌ 401 Unauthorized
// ❌ 404 Not Found
// ❌ 500 Server Error
```

**Status Codes:**
- `2xx` - Erfolg ✅
- `4xx` - Client Fehler ❌
- `5xx` - Server Fehler ❌

## Sichere HTTP-Workflows

### Workflow 1: Daten abrufen & verarbeiten
```
1. [TOOL:http({"method": "GET", "url": "api/endpoint"})]
   └─ Response Status überprüfen (200?)

2. [Response Body lesen]
   └─ Valid JSON? Felder vorhanden?

3. [Daten verarbeiten]
   └─ Mit [TOOL:filesystem] speichern oder [TOOL:shell] verarbeiten

4. [Optional: Daten aktualisieren]
   [TOOL:http({"method": "PATCH", "url": "api/endpoint", "body": {...}})]
```

### Workflow 2: API-Integration mit Authentifizierung
```
1. [Token abrufen oder laden]
   [TOOL:http({"method": "POST", "url": "api/auth/login", ...})]

2. [Token aus Response extrahieren]
   └─ Speichern für weitere Requests

3. [Authenticated Requests ausführen]
   [TOOL:http({
     "method": "GET",
     "url": "api/protected",
     "headers": {"Authorization": "Bearer TOKEN"}
   })]

4. [Token Refresh bei Ablauf]
   └─ 401 Error? Token abgelaufen? Neuen holen!
```

### Workflow 3: Batch-Requests (mehrere API-Calls)
```
1. [Request 1 - Benutzer erstellen]
   [TOOL:http({"method": "POST", "url": "api/users", "body": {...}})]
   └─ User ID aus Response speichern

2. [Request 2 - Daten hinzufügen]
   [TOOL:http({"method": "PATCH", "url": "api/users/{ID}", "body": {...}})]

3. [Request 3 - Verifizieren]
   [TOOL:http({"method": "GET", "url": "api/users/{ID}"})]
   └─ Alle Daten korrekt?
```

## Content-Types

**JSON (am häufigsten):**
```
"Content-Type": "application/json"
"Accept": "application/json"
```

**Form Data:**
```
"Content-Type": "application/x-www-form-urlencoded"
```

**Raw Text:**
```
"Content-Type": "text/plain"
```

**XML:**
```
"Content-Type": "application/xml"
```

## Authentication Patterns

### Bearer Token (API Keys)
```
"headers": {
  "Authorization": "Bearer sk-1234567890abcdef"
}
```

### Basic Auth
```
"headers": {
  "Authorization": "Basic base64(username:password)"
}
```

### API Key Header
```
"headers": {
  "X-API-Key": "your-api-key-here"
}
```

### OAuth 2.0
```
1. GET auth-token via OAuth flow
2. Use Bearer token in requests
```

⚠️ **KRITISCH:**
- Secrets NIEMALS in URLs/Query-Params
- Nur über HTTPS
- Token in secure environment variables speichern
- NIEMALS hardcoded in Skills/Code

## Performance-Tips

⚡ **Schnell:**
- Batch mehrere Requests parallel
- Pagination für große Datasets
- Caching verwenden (ETags, Cache-Control)
- Keep-Alive Connections

🐌 **Langsam:**
- Große Payloads ohne Compression
- Zu viele sequenzielle Requests
- Ohne Timeout (kann hängen)
- Polling ohne Backoff

## Common Errors & Solutions

### 401 Unauthorized
```
Problem: Token invalid, expired, or missing
Lösung:
1. Token überprüfen
2. Neuen Token holen wenn expired
3. Authorization Header korrekt?
```

### 400 Bad Request
```
Problem: Ungültige Anfrage
Lösung:
1. Request Body überprüfen (JSON valid?)
2. Pflicht-Felder vorhanden?
3. Parameter-Format korrekt?
```

### 404 Not Found
```
Problem: Ressource existiert nicht
Lösung:
1. URL korrekt?
2. ID korrekt?
3. Wurde Ressource gelöscht?
```

### 429 Too Many Requests
```
Problem: Rate Limit überschritten
Lösung:
1. Exponential Backoff implementieren
2. Requests bündeln
3. Cache nutzen
4. API-Provider fragen nach höherem Limit
```

### 500 Server Error
```
Problem: Server-Problem
Lösung:
1. Nicht deine Schuld
2. Retry mit Backoff
3. Fallback aktivieren
4. Support kontaktieren
```

## Best Practices

✅ **TUN:**
- Always use HTTPS (nicht HTTP)
- Error Responses überprüfen
- Timeouts setzen
- Retry mit Backoff für transienten Fehler
- Logging für Debug
- Rate Limits respektieren

❌ **NICHT TUN:**
- Secrets in URLs
- Hardcoded API Keys
- Keine Error Handling
- Infinite Retries
- Sensitive Daten in Logs
- HTTP statt HTTPS

## Response Handling

### JSON Response parsen
```
[TOOL:http({"method": "GET", "url": "api/endpoint"})]
// Response:
{
  "status": 200,
  "data": {
    "id": 123,
    "name": "John"
  }
}
```

### Status Code prüfen
```
Status 200-299: Success ✅
Status 300-399: Redirect (follow Location header)
Status 400-499: Client Error ❌
Status 500-599: Server Error ❌
```

### Headers nutzen
```
Häufig wichtig:
- Content-Type: Was ist der Response format?
- Location: Wohin redirecten? (3xx)
- Retry-After: Wie lange warten? (429, 503)
- Cache-Control: Darf ich cachen?
- ETag: Für conditional requests
```

## Integration mit anderen Skills

- **filesystem-operations:** Response speichern mit `write`
- **shell-commands:** API Response verarbeiten mit scripts
- **git-operations:** API-Changes committen

## Timeout & Limits

Beachte dass:
- API Requests können timeout
- Payload-Größe begrenzt (oft 10MB)
- Rate Limits existieren
- Connections timeout nach idle

## Häufige Use-Cases

### 1. Weather API abfragen
```
[TOOL:http({
  "method": "GET",
  "url": "https://api.weather.com/current?city=Berlin",
  "headers": {"Authorization": "Bearer API_KEY"}
})]
```

### 2. Datenbank via REST API
```
[TOOL:http({
  "method": "POST",
  "url": "https://db.example.com/records",
  "body": {"name": "John", "age": 30}
})]
```

### 3. Webhook ausführen
```
[TOOL:http({
  "method": "POST",
  "url": "https://webhooks.example.com/on-event",
  "body": {"event": "user_created", "userId": 123}
})]
```

### 4. Microservice kommunikation
```
[TOOL:http({
  "method": "GET",
  "url": "http://internal-service:3000/api/data"
})]
```

## Security Checklist

vor jedem API-Call:
- [ ] HTTPS? (nie HTTP)
- [ ] Auth-Token valide?
- [ ] Secrets in env-vars? (nie hardcoded)
- [ ] Response wird validiert?
- [ ] Timeout gesetzt?
- [ ] Rate-Limit beachtet?
- [ ] Error Handling vorhanden?
