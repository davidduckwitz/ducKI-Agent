# Agent Dashboard - API Specification

## Overview

This document specifies the WebSocket and HTTP API contracts needed to power the Agent Control Dashboard. All endpoints connect the frontend dashboard UI to the Phase 1-3B backend capabilities (hooks, events, approval policies, streaming).

---

## WebSocket API: Real-Time Execution Stream

### Connection
```
ws://localhost:3001/api/agents/stream/{sessionId}
```

**Authentication**: Requires valid session/auth token in header or query param.

**Response Headers**:
```
Connection: Upgrade
Upgrade: websocket
```

### Message Format

All WebSocket messages are JSON with this shape:
```typescript
interface AgentRunFrame {
  type: "start" | "chunk" | "event" | "iteration_complete" | "completion" | "error";
  timestamp: string;  // ISO 8601
  data: unknown;
}
```

### Frame Types

#### 1. **start** - Execution Started
Sent when agent begins execution.

```json
{
  "type": "start",
  "timestamp": "2026-07-29T14:23:45.123Z",
  "data": {
    "executionId": "exec-6e4c402-b8f3-4c9a-b0f7-1d2e3f4g5h6i",
    "conversationId": "conv-abc123",
    "input": "Add dark mode toggle to Dashboard",
    "maxIterations": 10
  }
}
```

#### 2. **chunk** - Model Response Chunk
Sent as LLM streams response (if streaming provider).

```json
{
  "type": "chunk",
  "timestamp": "2026-07-29T14:23:46.234Z",
  "data": {
    "chunk": "I'll help you add",
    "stopReason": null
  }
}
```

#### 3. **event** - Granular Agent Event
Sent for each AgentRunEvent (20+ types from Phase 1).

```json
{
  "type": "event",
  "timestamp": "2026-07-29T14:23:46.500Z",
  "data": {
    "eventType": "model_generation_started",
    "message": "Starting LLM generation with 5 messages in context",
    "eventTimestamp": "2026-07-29T14:23:46.500Z",
    "snapshot": {
      "conversationLength": 5,
      "currentIteration": 1,
      "maxIterations": 10,
      "toolsUsedThisIteration": 0,
      "toolsUsedInRun": 0,
      "estimatedTokensUsed": 450,
      "memoryContextSize": 1200,
      "elapsed": 1234
    },
    "eventData": {
      "maxTokens": 4096,
      "systemPromptLength": 2500
    }
  }
}
```

#### 4. **tool_approval_pending** - Tool Requires User Approval
Sent when approval policy requires confirmation.

```json
{
  "type": "tool_approval_pending",
  "timestamp": "2026-07-29T14:23:47.600Z",
  "data": {
    "toolCallId": "call-xyz789",
    "toolName": "filesystem",
    "input": {
      "action": "write",
      "path": "src/components/Dashboard.tsx",
      "content": "..."
    },
    "reason": "RequireConfirmation: Shell commands require approval",
    "timeoutMs": 30000
  }
}
```

**Client must respond within timeoutMs with approval via HTTP endpoint.**

#### 5. **iteration_complete** - Iteration Finished
Sent at end of each iteration.

```json
{
  "type": "iteration_complete",
  "timestamp": "2026-07-29T14:23:50.123Z",
  "data": {
    "iteration": 1,
    "toolsExecuted": ["filesystem"],
    "tokensUsed": 1450,
    "durationMs": 4623,
    "avgIterationTimeMs": 4623,
    "reasoning": "Read source file, next will extract functions"
  }
}
```

#### 6. **completion** - Execution Completed Successfully
Sent when agent finishes with success.

```json
{
  "type": "completion",
  "timestamp": "2026-07-29T14:23:55.456Z",
  "data": {
    "executionId": "exec-6e4c402-b8f3-4c9a-b0f7-1d2e3f4g5h6i",
    "totalIterations": 3,
    "totalTokensUsed": 4350,
    "totalCost": 0.0065,
    "durationMs": 9876,
    "result": "Successfully added dark mode toggle to Dashboard"
  }
}
```

#### 7. **error** - Execution Failed
Sent when agent encounters fatal error.

```json
{
  "type": "error",
  "timestamp": "2026-07-29T14:23:55.789Z",
  "data": {
    "executionId": "exec-6e4c402-b8f3-4c9a-b0f7-1d2e3f4g5h6i",
    "error": "Max iterations reached without completion",
    "errorCode": "MAX_ITERATIONS_EXCEEDED",
    "iteration": 10,
    "partialResult": "Partial progress made..."
  }
}
```

---

## HTTP API Endpoints

### 1. Start Agent Execution

```
POST /api/agents/execute
```

**Request**:
```typescript
{
  "input": string;                    // User goal/instruction
  "conversationId"?: string;          // Optional: continue existing conversation
  "maxIterations"?: number;           // Default: 10
  "approvalMode"?: "auto" | "manual"; // Default: "auto" (all tools approved)
  "approvalPolicy"?: ToolApprovalPolicy; // Custom approval rules
  "hooks"?: AgentHook[];              // Custom hooks
}
```

**Response (200 OK)**:
```typescript
{
  "executionId": string;              // Unique execution identifier
  "conversationId": string;           // Conversation ID (new or existing)
  "streamUrl": string;                // WebSocket URL for streaming
  "status": "running";
  "startedAt": string;                // ISO 8601 timestamp
}
```

**Error (400 Bad Request)**:
```typescript
{
  "error": "Invalid input",
  "details": "Input must be non-empty string"
}
```

**Error (429 Too Many Requests)**:
```typescript
{
  "error": "Rate limit exceeded",
  "retryAfter": 60
}
```

---

### 2. Approve/Deny Tool Call

```
POST /api/agents/approve-tool
```

**Request**:
```typescript
{
  "executionId": string;              // From stream frame
  "toolCallId": string;               // From tool_approval_pending
  "approved": boolean;                // true to approve, false to deny
  "correctedInput"?: Record<string, unknown>; // Optional: corrected input
  "reason"?: string;                  // Optional: user's reason
}
```

**Response (200 OK)**:
```typescript
{
  "success": true,
  "toolCallId": string,
  "action": "approved" | "denied" | "modified"
}
```

**Error (404 Not Found)**:
```typescript
{
  "error": "Tool call not found",
  "details": "toolCallId xyz789 is no longer pending"
}
```

**Error (408 Request Timeout)**:
```typescript
{
  "error": "Approval timeout",
  "details": "Tool call approval window expired"
}
```

---

### 3. Steer Agent Mid-Execution

```
POST /api/agents/steer
```

**Request**:
```typescript
{
  "executionId": string;              // Current execution
  "instruction": string;              // User guidance
  "action"?: "continue" | "retry" | "skip" | "modify";
}
```

**Response (200 OK)**:
```typescript
{
  "success": true,
  "action": "instruction_queued",
  "message": "Agent will process instruction at next iteration"
}
```

**Error (409 Conflict)**:
```typescript
{
  "error": "Execution not running",
  "status": "completed" | "failed" | "idle"
}
```

---

### 4. Get Current Metrics

```
GET /api/agents/metrics/{executionId}
```

**Response (200 OK)**:
```typescript
{
  "executionId": string,
  "iteration": number;
  "maxIterations": number;
  "elapsed": number;              // milliseconds
  "status": "running" | "completed" | "failed";
  
  // Timing metrics
  "iterationAvgMs": number;
  "iterationMinMs": number;
  "iterationMaxMs": number;
  
  // Tool metrics
  "totalToolCalls": number;
  "toolCallsApproved": number;
  "toolCallsDenied": number;
  "toolsUsed": string[];          // e.g., ["filesystem", "shell"]
  
  // Cost metrics
  "estimatedTokensUsed": number;
  "estimatedCost": number;        // USD
  "tokenBreakdown": {
    "prompt": number;
    "completion": number;
  };
  
  // Hook metrics
  "hooksRegistered": number;
  "hookOverheadMs": number;
  
  // Event metrics
  "eventsEmitted": number;
  "eventBatchesEmitted": number;
}
```

---

### 5. Stop Execution

```
POST /api/agents/stop/{executionId}
```

**Request**:
```typescript
{
  "graceful"?: boolean;   // Default: true (finish current iteration)
  "reason"?: string;      // Optional: why stopping
}
```

**Response (200 OK)**:
```typescript
{
  "success": true,
  "executionId": string,
  "stoppedAt": string,    // ISO 8601
  "iterationsCompleted": number,
  "totalCost": number
}
```

---

### 6. Get Execution History

```
GET /api/agents/executions
```

**Query Parameters**:
```
?status=running|completed|failed
&limit=20
&offset=0
&sortBy=startedAt|cost|duration
&sortOrder=asc|desc
```

**Response (200 OK)**:
```typescript
{
  "executions": [
    {
      "executionId": string,
      "conversationId": string,
      "input": string;
      "status": "completed" | "failed";
      "startedAt": string;
      "completedAt": string;
      "duration": number;         // milliseconds
      "iterations": number;
      "tokensUsed": number;
      "cost": number;             // USD
      "toolsUsed": string[];
      "result": string;           // Completion result or error message
    }
  ],
  "total": number,
  "hasMore": boolean
}
```

---

### 7. Replay Execution Events

```
GET /api/agents/executions/{executionId}/events
```

**Query Parameters**:
```
?startIteration=1
&endIteration=5
&eventType=tool_execution_completed
&limit=50
```

**Response (200 OK)**:
```typescript
{
  "executionId": string,
  "events": [
    {
      "timestamp": string;
      "iteration": number;
      "eventType": string;
      "message": string;
      "data": unknown;
      "snapshot": AgentRunEventSnapshot;
    }
  ],
  "total": number
}
```

---

### 8. Update Approval Policy

```
POST /api/agents/policies
```

**Request**:
```typescript
{
  "name": string;
  "rules": ToolApprovalRule[];
  "strategy": "AND" | "OR";  // How rules combine
  "description"?: string;
}
```

**Response (200 OK)**:
```typescript
{
  "policyId": string,
  "name": string,
  "rules": ToolApprovalRule[],
  "createdAt": string,
  "updatedAt": string
}
```

---

### 9. Get Approval Policies

```
GET /api/agents/policies
```

**Response (200 OK)**:
```typescript
{
  "policies": [
    {
      "policyId": string,
      "name": string,
      "description": string,
      "rules": ToolApprovalRule[],
      "createdAt": string,
      "createdBy": string
    }
  ]
}
```

---

## Data Types

### ToolApprovalRule
```typescript
interface ToolApprovalRule {
  type: "allow" | "deny" | "require_confirmation";
  toolName: string;           // e.g., "shell", "filesystem", "*" for all
  pattern?: string;           // Regex pattern for inputs
  action?: string;            // Specific action (e.g., "write" for filesystem)
  reason?: string;            // Why this rule exists
}
```

### AgentHook
```typescript
interface AgentHook {
  name: string;
  priority?: number;          // 0-100, higher = runs later
  handler: (context: unknown) => Promise<{
    proceed: boolean;
    output?: unknown;
    reason?: string;
  }>;
}
```

### ToolApprovalPolicy
```typescript
interface ToolApprovalPolicy {
  rules: ToolApprovalRule[];
  strategy?: "AND" | "OR";     // How to combine rules
  defaultAction?: "allow" | "deny"; // If no rules match
}
```

### AgentRunEventSnapshot
```typescript
interface AgentRunEventSnapshot {
  conversationLength: number;
  currentIteration: number;
  maxIterations: number;
  toolsUsedThisIteration: string[];
  toolsUsedInRun: string[];
  estimatedTokensUsed: number;
  memoryContextSize: number;
  elapsed: number;             // milliseconds
  timestamp: string;            // ISO 8601
}
```

---

## Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| `INVALID_INPUT` | 400 | Request validation failed |
| `UNAUTHORIZED` | 401 | Auth failed |
| `FORBIDDEN` | 403 | User lacks permission |
| `NOT_FOUND` | 404 | Execution/resource not found |
| `CONFLICT` | 409 | State conflict (e.g., already running) |
| `RATE_LIMITED` | 429 | Too many requests |
| `TIMEOUT` | 408 | Approval window expired |
| `INTERNAL_ERROR` | 500 | Server error |

---

## Example Flow

### 1. Start Execution
```bash
curl -X POST http://localhost:3001/api/agents/execute \
  -H "Content-Type: application/json" \
  -d '{"input": "Add dark mode toggle"}'

# Response:
{
  "executionId": "exec-abc123",
  "conversationId": "conv-xyz789",
  "streamUrl": "ws://localhost:3001/api/agents/stream/session-123"
}
```

### 2. Connect WebSocket
```javascript
const ws = new WebSocket('ws://localhost:3001/api/agents/stream/session-123');

ws.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  console.log('Frame:', frame.type, frame.data);
};
```

### 3. Receive tool approval request
```json
{
  "type": "tool_approval_pending",
  "data": {
    "toolCallId": "call-xyz",
    "toolName": "shell",
    "input": {"command": "npm install"}
  }
}
```

### 4. Approve tool
```bash
curl -X POST http://localhost:3001/api/agents/approve-tool \
  -H "Content-Type: application/json" \
  -d '{
    "executionId": "exec-abc123",
    "toolCallId": "call-xyz",
    "approved": true
  }'
```

### 5. Receive completion
```json
{
  "type": "completion",
  "data": {
    "executionId": "exec-abc123",
    "result": "Successfully added dark mode toggle"
  }
}
```

---

## Performance Requirements

- **WebSocket latency**: < 100ms end-to-end
- **HTTP endpoints**: < 200ms response time
- **Event batching**: 50ms interval, max 20 events per batch
- **Memory per execution**: < 50MB for 1000 events
- **Concurrent executions**: Support 10+ simultaneous

---

## Security Considerations

1. **Authentication**: All endpoints require valid session/JWT
2. **Authorization**: Users can only access their own executions
3. **Rate Limiting**: 100 requests/min per user
4. **Input Validation**: Sanitize all user input before processing
5. **Approval Policies**: Cannot bypass security-critical rules
6. **WebSocket Timeout**: Auto-close after 5 minutes inactivity

---

## Implementation Notes

### For Backend Developers

1. Use AgentRunnerV2 async generator for streaming
2. Connect EventEmitterV2 to WebSocket sender
3. Implement tool approval gate via beforeTool hook
4. Store execution metrics in database
5. Implement graceful shutdown for long-running executions

### For Frontend Developers

1. Connect dashboard to WebSocket before starting execution
2. Handle connection drops with retry logic
3. Update metrics periodically (don't rely on events alone)
4. Show approval modal on `tool_approval_pending` frame
5. Auto-scroll event feed
6. Persist execution history to localStorage

---

**Version**: 1.0  
**Last Updated**: 2026-07-29  
**Status**: ✅ Ready for Implementation
