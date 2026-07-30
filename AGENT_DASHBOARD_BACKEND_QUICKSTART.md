# Agent Dashboard - Backend Implementation Quick-Start

## Overview

This guide shows how to wire up the backend to feed real-time agent execution data to the Dashboard. Estimated implementation time: **2-4 hours**.

## Prerequisites

✅ Phase 1-3B backend already implemented:
- `HookRegistry` (hooks/agent-hooks.ts)
- `EventEmitterV2` (events/event-emitter-v2.ts)
- `ToolApprovalPolicy` (tools/tool-approval-policy.ts)
- `AgentRunnerV2` (agent-runner-v2.ts)
- `Agent` with streaming support

## Step 1: WebSocket Handler Setup

Create `apps/server/src/handlers/websocket-handler.ts`:

```typescript
import { WebSocket, WebSocketServer } from 'ws';
import type { AgentRunFrame } from '@ducki/agent';

interface ActiveExecution {
  executionId: string;
  ws: WebSocket;
  createdAt: Date;
  approval?: {
    toolCallId: string;
    timeout: NodeJS.Timeout;
  };
}

class ExecutionStreamManager {
  private executions = new Map<string, ActiveExecution>();
  private wss: WebSocketServer;

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
  }

  private handleConnection(ws: WebSocket) {
    const url = new URL(`http://localhost${ws.url || ''}`);
    const executionId = url.searchParams.get('executionId');

    if (!executionId) {
      ws.close(1008, 'Missing executionId');
      return;
    }

    this.executions.set(executionId, {
      executionId,
      ws,
      createdAt: new Date(),
    });

    console.log(`WebSocket connected for execution: ${executionId}`);

    ws.on('close', () => {
      this.executions.delete(executionId);
      console.log(`WebSocket closed for execution: ${executionId}`);
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for ${executionId}:`, error);
    });
  }

  sendFrame(executionId: string, frame: AgentRunFrame): boolean {
    const execution = this.executions.get(executionId);
    if (!execution) return false;

    try {
      execution.ws.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      console.error(`Failed to send frame to ${executionId}:`, error);
      return false;
    }
  }

  closeExecution(executionId: string) {
    const execution = this.executions.get(executionId);
    if (execution?.approval?.timeout) {
      clearTimeout(execution.approval.timeout);
    }
    execution?.ws.close();
    this.executions.delete(executionId);
  }

  static getInstance(): ExecutionStreamManager {
    if (!global.executionStreamManager) {
      global.executionStreamManager = new ExecutionStreamManager(3002); // WebSocket port
    }
    return global.executionStreamManager;
  }
}

export { ExecutionStreamManager };
```

## Step 2: Agent Execution Endpoint

Create `apps/server/src/routes/agents.ts`:

```typescript
import express from 'express';
import { AgentRunnerV2 } from '@ducki/agent';
import { ExecutionStreamManager } from '../handlers/websocket-handler';
import type { Request, Response } from 'express';

const router = express.Router();
const streamManager = ExecutionStreamManager.getInstance();

// Store active approvals (tool call ID → promise)
const pendingApprovals = new Map<string, {
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();

// POST /api/agents/execute
router.post('/execute', async (req: Request, res: Response) => {
  try {
    const { input, conversationId, maxIterations = 10, approvalPolicy } = req.body;

    if (!input) {
      return res.status(400).json({ error: 'Input required' });
    }

    const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const streamUrl = `ws://localhost:3002?executionId=${executionId}`;

    res.json({
      executionId,
      conversationId: conversationId || `conv-${Date.now()}`,
      streamUrl,
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    // Run agent in background
    runAgentExecution(executionId, input, {
      conversationId,
      maxIterations,
      approvalPolicy,
    });
  } catch (error) {
    res.status(500).json({ error: 'Execution failed', details: String(error) });
  }
});

// Main agent execution with streaming
async function runAgentExecution(
  executionId: string,
  userInput: string,
  options: any
) {
  try {
    const provider = getProvider(); // Your LLM provider
    const db = getDatabase();       // Your database

    // Create agent runner
    const runner = new AgentRunnerV2(provider, db);

    // Register approval gate hook
    runner.getAgent().hookRegistry?.register('tool_approval_gate', {
      name: 'tool_approval_gate',
      priority: 90,
      async handler(context: any) {
        if (context.hookName === 'beforeTool') {
          const approval = await requestApproval(
            executionId,
            context.toolName,
            context.input
          );
          return { proceed: approval };
        }
        return { proceed: true };
      },
    });

    // Stream frames to WebSocket
    for await (const frame of runner.run(userInput, options)) {
      streamManager.sendFrame(executionId, frame as any);

      // Handle tool approval frame
      if (frame.type === 'tool_approval_pending') {
        const approval = frame.data as any;
        const toolCallId = approval.toolCallId;

        // Wait for approval (with timeout)
        const approved = await waitForApproval(toolCallId, 30000);
        
        // Send approval result back via special frame
        streamManager.sendFrame(executionId, {
          type: 'tool_approval_response',
          timestamp: new Date().toISOString(),
          data: { toolCallId, approved },
        });
      }
    }

    streamManager.closeExecution(executionId);
  } catch (error) {
    streamManager.sendFrame(executionId, {
      type: 'error',
      timestamp: new Date().toISOString(),
      data: {
        executionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    });
    streamManager.closeExecution(executionId);
  }
}

// POST /api/agents/approve-tool
router.post('/approve-tool', (req: Request, res: Response) => {
  const { toolCallId, approved } = req.body;

  const approval = pendingApprovals.get(toolCallId);
  if (!approval) {
    return res.status(404).json({ error: 'Approval not found' });
  }

  clearTimeout(approval.timeout);
  pendingApprovals.delete(toolCallId);
  approval.resolve(approved);

  res.json({ success: true, toolCallId, action: approved ? 'approved' : 'denied' });
});

// Helper: Request tool approval
async function requestApproval(
  executionId: string,
  toolName: string,
  input: any
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const toolCallId = `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutMs = 30000;

    // Send approval request to WebSocket
    streamManager.sendFrame(executionId, {
      type: 'tool_approval_pending',
      timestamp: new Date().toISOString(),
      data: {
        toolCallId,
        toolName,
        input,
        timeoutMs,
      },
    });

    // Set up approval promise
    const timeout = setTimeout(() => {
      pendingApprovals.delete(toolCallId);
      reject(new Error(`Approval timeout for ${toolCallId}`));
    }, timeoutMs);

    pendingApprovals.set(toolCallId, {
      resolve: (approved) => {
        clearTimeout(timeout);
        resolve(approved);
      },
      reject,
      timeout,
    });
  });
}

// Helper: Wait for approval
function waitForApproval(toolCallId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Approval timeout for ${toolCallId}`));
    }, timeoutMs);

    const approval = pendingApprovals.get(toolCallId);
    if (approval) {
      approval.resolve = (approved) => {
        clearTimeout(timeout);
        resolve(approved);
      };
      approval.reject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
    }
  });
}

// POST /api/agents/stop/{executionId}
router.post('/stop/:executionId', (req: Request, res: Response) => {
  const { executionId } = req.params;
  streamManager.closeExecution(executionId);

  res.json({
    success: true,
    executionId,
    stoppedAt: new Date().toISOString(),
  });
});

// GET /api/agents/metrics/{executionId}
router.get('/metrics/:executionId', async (req: Request, res: Response) => {
  const { executionId } = req.params;

  // Query database for execution metrics
  const metrics = await getExecutionMetrics(executionId);

  res.json(metrics || {
    iterationAvgMs: 0,
    totalToolCalls: 0,
    toolCallsApproved: 0,
    toolCallsDenied: 0,
    estimatedCost: 0,
    tokensUsed: 0,
  });
});

// GET /api/agents/executions
router.get('/executions', async (req: Request, res: Response) => {
  const { status, limit = 20, offset = 0 } = req.query;

  const executions = await getExecutionHistory({
    status: status as string,
    limit: parseInt(limit as string),
    offset: parseInt(offset as string),
  });

  res.json({
    executions: executions.data,
    total: executions.total,
    hasMore: executions.hasMore,
  });
});

// GET /api/agents/executions/{executionId}/events
router.get('/executions/:executionId/events', async (req: Request, res: Response) => {
  const { executionId } = req.params;
  const { startIteration, endIteration, eventType, limit = 50 } = req.query;

  const events = await getExecutionEvents(executionId, {
    startIteration: startIteration ? parseInt(startIteration as string) : undefined,
    endIteration: endIteration ? parseInt(endIteration as string) : undefined,
    eventType: eventType as string,
    limit: parseInt(limit as string),
  });

  res.json({
    executionId,
    events,
    total: events.length,
  });
});

export { router as agentRouter };
```

## Step 3: Database Schema for Execution Tracking

Add to your database migrations:

```sql
-- Executions table
CREATE TABLE executions (
  id VARCHAR(255) PRIMARY KEY,
  conversation_id VARCHAR(255),
  input TEXT NOT NULL,
  status ENUM('running', 'completed', 'failed') DEFAULT 'running',
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  
  -- Metrics
  iterations INTEGER DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  cost DECIMAL(10, 6),
  duration_ms INTEGER,
  
  -- Result
  result_text TEXT,
  error_message TEXT,
  
  -- Metadata
  created_by VARCHAR(255),
  metadata JSON,
  
  INDEX idx_status (status),
  INDEX idx_created_by (created_by),
  INDEX idx_started_at (started_at)
);

-- Execution events table
CREATE TABLE execution_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  execution_id VARCHAR(255) NOT NULL,
  iteration INTEGER,
  event_type VARCHAR(100),
  message TEXT,
  event_data JSON,
  snapshot JSON,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE,
  INDEX idx_execution_id (execution_id),
  INDEX idx_event_type (event_type)
);

-- Tool approvals table
CREATE TABLE tool_approvals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  execution_id VARCHAR(255),
  tool_call_id VARCHAR(255) UNIQUE,
  tool_name VARCHAR(100),
  input_data JSON,
  approved BOOLEAN,
  approved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_execution_id (execution_id),
  INDEX idx_tool_call_id (tool_call_id)
);
```

## Step 4: Register Routes in Main Server

In `apps/server/src/index.ts`:

```typescript
import express from 'express';
import { agentRouter } from './routes/agents';

const app = express();

// Middleware
app.use(express.json());

// Routes
app.use('/api/agents', agentRouter);

// Start server
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket stream available on port 3002`);
});
```

## Step 5: Connect Frontend to WebSocket

Update Dashboard component:

```typescript
useEffect(() => {
  if (executionStatus !== 'running') return;

  const ws = new WebSocket(
    `ws://localhost:3002?executionId=${executionId}`
  );

  ws.onmessage = (event) => {
    const frame = JSON.parse(event.data);

    switch (frame.type) {
      case 'event':
        setEvents(prev => [...prev, frame.data]);
        setMetrics(prev => ({
          ...prev,
          tokensUsed: frame.data.snapshot?.estimatedTokensUsed || prev.tokensUsed,
        }));
        break;

      case 'iteration_complete':
        setCurrentIteration(frame.data.iteration);
        setMetrics(prev => ({
          ...prev,
          iterationAvgMs: frame.data.avgIterationTimeMs,
        }));
        break;

      case 'tool_approval_pending':
        setPendingApproval({
          id: frame.data.toolCallId,
          toolName: frame.data.toolName,
          input: frame.data.input,
          timestamp: frame.timestamp,
        });
        break;

      case 'completion':
        setExecutionStatus('completed');
        ws.close();
        break;

      case 'error':
        setExecutionStatus('failed');
        ws.close();
        break;
    }
  };

  return () => ws.close();
}, [executionStatus, executionId]);

const handleApproveToolCall = async () => {
  if (!pendingApproval) return;

  await fetch('/api/agents/approve-tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      toolCallId: pendingApproval.id,
      approved: true,
    }),
  });

  setPendingApproval(null);
};
```

## Step 6: Testing

### Test with curl
```bash
# Start execution
curl -X POST http://localhost:3001/api/agents/execute \
  -H "Content-Type: application/json" \
  -d '{"input": "Add dark mode toggle"}'

# Response:
# {
#   "executionId": "exec-...",
#   "streamUrl": "ws://localhost:3002?executionId=exec-..."
# }

# In another terminal, connect WebSocket
wscat -c "ws://localhost:3002?executionId=exec-..."

# Should see event stream flowing in
```

### Test approval flow
```bash
# After seeing tool_approval_pending in WebSocket:
curl -X POST http://localhost:3001/api/agents/approve-tool \
  -H "Content-Type: application/json" \
  -d '{
    "toolCallId": "call-xyz",
    "approved": true
  }'
```

## Implementation Checklist

- [ ] WebSocket handler created and listening on port 3002
- [ ] ExecutionStreamManager singleton set up
- [ ] `/api/agents/execute` endpoint implemented
- [ ] AgentRunnerV2 integrated with streaming
- [ ] Tool approval gate hook registered
- [ ] `/api/agents/approve-tool` endpoint implemented
- [ ] `/api/agents/stop` endpoint implemented
- [ ] `/api/agents/metrics` endpoint implemented
- [ ] Database tables created for executions/events
- [ ] Frontend WebSocket connection established
- [ ] Dashboard state updates from WebSocket frames
- [ ] Tool approval modal shows and handles approval
- [ ] E2E test: Execute → See events → Approve → Complete

## Performance Tips

1. **Use message buffering**: Don't send every event immediately; batch them (EventEmitterV2 does this)
2. **Cleanup connections**: Clear pending approvals and close WebSocket after execution
3. **Database indexing**: Add indexes on execution_id and event_type for fast queries
4. **Memory limits**: Store only last 1000 events in memory per execution

## Common Issues

**WebSocket connection refused**
→ Ensure WebSocketServer is listening on correct port (3002)

**Tool call approval timing out**
→ Check that `/api/agents/approve-tool` is being called
→ Increase timeout if network is slow

**Events not flowing to UI**
→ Check WebSocket frame format matches frontend expectations
→ Add logging: `console.log('Sending frame:', frame)`

**High memory usage**
→ Limit execution history to last 1000 events
→ Archive old executions to separate table

---

**Time to implement**: 2-4 hours  
**Difficulty**: Medium  
**Dependencies**: Phase 1-3B backend + AgentRunnerV2

Ready to start? Begin with Step 1! 🚀
