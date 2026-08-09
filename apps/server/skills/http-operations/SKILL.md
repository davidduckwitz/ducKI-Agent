---
name: http-operations
description: Make safe and effective HTTP requests and API calls - fetch data and integrate external services with best practices for security, performance, and error handling. Use for HTTP or API tasks.
---

# Skill: HTTP Operations

## Summary
Safe and effective HTTP requests and API calls. Call APIs, fetch data, integrate external services - all with best practices for security, performance, and error handling.

## Core functions

### 1. GET request (fetch data)
```
[TOOL:http({
  "method": "GET",
  "url": "https://api.example.com/users/123"
})]
```

**When to use:**
- Fetch data from APIs
- Query external services
- Check status
- Load public data

**With query parameters:**
```
[TOOL:http({
  "method": "GET",
  "url": "https://api.example.com/search?q=nodejs&limit=10"
})]
```

**With headers:**
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

### 2. POST request (send data)
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

**When to use:**
- Create new data
- Submit forms
- Execute API commands
- Store data

⚠️ **IMPORTANT:**
- Set the Content-Type header!
- Always use an authorization token (when needed)
- The body must be valid JSON
- Do NOT put secrets in URLs!

### 3. PUT request (update data)
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

**When to use:**
- Update the entire resource
- Replace the complete data
- Not for partial updates (use PATCH)

### 4. PATCH request (partial update)
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

**When to use:**
- Update only individual fields
- Efficient (small payload)
- Do not lose existing data

**PUT vs PATCH:**
```
PUT:   Replace EVERYTHING with: {"name":"Jane", "email":"jane@ex.com"}
PATCH: Change only: {"email":"jane@example.com"} (name stays!)
```

### 5. DELETE request (delete data)
```
[TOOL:http({
  "method": "DELETE",
  "url": "https://api.example.com/users/123",
  "headers": {
    "Authorization": "Bearer TOKEN"
  }
})]
```

**When to use:**
- Delete resources
- Clean up data
- Deactivate users

⚠️ **CAUTION:**
- Deletion is PERMANENT
- Always check existence before DELETE
- Auth token correct?

### 6. Error handling
```
[TOOL:http({
  "method": "GET",
  "url": "https://api.example.com/data",
  "headers": {
    "Authorization": "Bearer TOKEN"
  }
})]
// Check the response:
// ✅ 200 OK
// ✅ 201 Created
// ❌ 400 Bad Request
// ❌ 401 Unauthorized
// ❌ 404 Not Found
// ❌ 500 Server Error
```

**Status codes:**
- `2xx` - success ✅
- `4xx` - client error ❌
- `5xx` - server error ❌

## Safe HTTP workflows

### Workflow 1: fetch & process data
```
1. [TOOL:http({"method": "GET", "url": "api/endpoint"})]
   └─ Check the response status (200?)

2. [Read the response body]
   └─ Valid JSON? Fields present?

3. [Process the data]
   └─ Save with [TOOL:filesystem] or process with [TOOL:shell]

4. [Optional: update data]
   [TOOL:http({"method": "PATCH", "url": "api/endpoint", "body": {...}})]
```

### Workflow 2: API integration with authentication
```
1. [Fetch or load a token]
   [TOOL:http({"method": "POST", "url": "api/auth/login", ...})]

2. [Extract the token from the response]
   └─ Store it for further requests

3. [Run authenticated requests]
   [TOOL:http({
     "method": "GET",
     "url": "api/protected",
     "headers": {"Authorization": "Bearer TOKEN"}
   })]

4. [Refresh the token on expiry]
   └─ 401 error? Token expired? Get a new one!
```

### Workflow 3: batch requests (multiple API calls)
```
1. [Request 1 - create a user]
   [TOOL:http({"method": "POST", "url": "api/users", "body": {...}})]
   └─ Save the user ID from the response

2. [Request 2 - add data]
   [TOOL:http({"method": "PATCH", "url": "api/users/{ID}", "body": {...}})]

3. [Request 3 - verify]
   [TOOL:http({"method": "GET", "url": "api/users/{ID}"})]
   └─ All data correct?
```

## Content types

**JSON (most common):**
```
"Content-Type": "application/json"
"Accept": "application/json"
```

**Form data:**
```
"Content-Type": "application/x-www-form-urlencoded"
```

**Raw text:**
```
"Content-Type": "text/plain"
```

**XML:**
```
"Content-Type": "application/xml"
```

## Authentication patterns

### Bearer token (API keys)
```
"headers": {
  "Authorization": "Bearer sk-1234567890abcdef"
}
```

### Basic auth
```
"headers": {
  "Authorization": "Basic base64(username:password)"
}
```

### API key header
```
"headers": {
  "X-API-Key": "your-api-key-here"
}
```

### OAuth 2.0
```
1. GET an auth token via the OAuth flow
2. Use the Bearer token in requests
```

⚠️ **CRITICAL:**
- NEVER put secrets in URLs/query params
- Only over HTTPS
- Store tokens in secure environment variables
- NEVER hardcode them in skills/code

## Performance tips

⚡ **Fast:**
- Batch multiple requests in parallel
- Pagination for large datasets
- Use caching (ETags, Cache-Control)
- Keep-Alive connections

🐌 **Slow:**
- Large payloads without compression
- Too many sequential requests
- No timeout (can hang)
- Polling without backoff

## Common errors & solutions

### 401 Unauthorized
```
Problem: Token invalid, expired, or missing
Solution:
1. Check the token
2. Get a new token if expired
3. Is the Authorization header correct?
```

### 400 Bad Request
```
Problem: Invalid request
Solution:
1. Check the request body (valid JSON?)
2. Are required fields present?
3. Is the parameter format correct?
```

### 404 Not Found
```
Problem: Resource does not exist
Solution:
1. Is the URL correct?
2. Is the ID correct?
3. Was the resource deleted?
```

### 429 Too Many Requests
```
Problem: Rate limit exceeded
Solution:
1. Implement exponential backoff
2. Bundle requests
3. Use caching
4. Ask the API provider for a higher limit
```

### 500 Server Error
```
Problem: Server-side problem
Solution:
1. Not your fault
2. Retry with backoff
3. Activate a fallback
4. Contact support
```

## Best Practices

✅ **DO:**
- Always use HTTPS (not HTTP)
- Check error responses
- Set timeouts
- Retry with backoff for transient errors
- Logging for debug
- Respect rate limits

❌ **DON'T:**
- Secrets in URLs
- Hardcoded API keys
- No error handling
- Infinite retries
- Sensitive data in logs
- HTTP instead of HTTPS

## Response handling

### Parse a JSON response
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

### Check the status code
```
Status 200-299: success ✅
Status 300-399: redirect (follow the Location header)
Status 400-499: client error ❌
Status 500-599: server error ❌
```

### Use headers
```
Often important:
- Content-Type: what is the response format?
- Location: where to redirect? (3xx)
- Retry-After: how long to wait? (429, 503)
- Cache-Control: may I cache?
- ETag: for conditional requests
```

## Integration with other skills

- **filesystem-operations:** save the response with `write`
- **shell-commands-win / shell-commands-nix:** process the API response with scripts (pick the one matching the host OS)
- **git-operations:** commit API changes

## Timeout & limits

Note that:
- API requests can time out
- Payload size is limited (often 10MB)
- Rate limits exist
- Connections time out after idle

## Common use cases

### 1. Query a weather API
```
[TOOL:http({
  "method": "GET",
  "url": "https://api.weather.com/current?city=Berlin",
  "headers": {"Authorization": "Bearer API_KEY"}
})]
```

### 2. Database via REST API
```
[TOOL:http({
  "method": "POST",
  "url": "https://db.example.com/records",
  "body": {"name": "John", "age": 30}
})]
```

### 3. Trigger a webhook
```
[TOOL:http({
  "method": "POST",
  "url": "https://webhooks.example.com/on-event",
  "body": {"event": "user_created", "userId": 123}
})]
```

### 4. Microservice communication
```
[TOOL:http({
  "method": "GET",
  "url": "http://internal-service:3000/api/data"
})]
```

## Security checklist

Before every API call:
- [ ] HTTPS? (never HTTP)
- [ ] Auth token valid?
- [ ] Secrets in env vars? (never hardcoded)
- [ ] Is the response validated?
- [ ] Timeout set?
- [ ] Rate limit respected?
- [ ] Error handling present?
