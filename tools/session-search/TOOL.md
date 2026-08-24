---
name: session_search
description: Full-text search across all past conversations to recall what was discussed
core: false
parameters:
  query:
    type: string
    description: Search query to find in past messages
    required: true
  max_results:
    type: number
    description: Maximum results (default 10)
    required: false
---

Find what was discussed in past conversations. Use this when:
- The user asks "did we talk about X before?" or "what did we decide about Y?"
- You need context from a prior session that isn't in your active memory
- You need to recall specific details the user mentioned weeks ago

Returns message snippets with conversation context (conversation name, timestamp).