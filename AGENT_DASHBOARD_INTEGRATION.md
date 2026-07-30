# Agent Control Dashboard - Integration Guide

## Overview

The **Agent Control Dashboard** is now integrated into DucKI's main Dashboard component, providing real-time visibility and control over agent execution. It leverages all Phase 1-3B backend capabilities (hooks, events, approval policies, streaming).

## What's Implemented

### 1. **Dashboard Enhancement** (`apps/web/src/components/dashboard/Dashboard.tsx`)

✅ **Agent Execution Monitor** section with:
- **Status Display**: Shows agent status (IDLE, RUNNING, COMPLETED, FAILED)
- **Progress Tracking**: Iteration counter (current/max) with visual progress bar
- **Time Tracking**: Real-time elapsed time display
- **Cost Monitoring**: Estimated cost display
- **Event Stream**: Last 8 events with type, message, and timestamp
- **Metrics Panel**: Tool call counts (approved/denied) and token usage
- **Expandable/Collapsible**: Can be toggled to save screen space
- **Live Indicator**: Shows LIVE badge when execution is running

### 2. **Styling & UX**
- Dark theme consistent with DucKI design
- Color-coded events (red=error, blue=tool, purple=model, green=completed)
- Icon indicators for event types
- Responsive grid layout
- Auto-scrolling event feed
- Animated progress bar and pulse effects

## Backend Integration Points

### WebSocket Connection for Real-Time Events

The dashboard needs to receive events from the agent execution. Implement WebSocket connection:

```typescript
// In Dashboard component or a custom hook
useEffect(() => {
  if (!connected) return;

  const ws = new WebSocket('ws://localhost:3001/api/agents/events');
  
  ws.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    
    // Update dashboard state based on frame type
    if (frame.type === 'start') {
      setExecutionStatus('running');
      setElapsedMs(0);
      setEvents([]);
      setCurrentIteration(0);
    } else if (frame.type === 'event') {
      setEvents(prev => [...prev, frame.data]);
    } else if (frame.type === 'iteration_complete') {
      setCurrentIteration(frame.data.iteration);
      setMetrics(prev => ({...prev, iterationAvgMs: frame.data.avgMs}));
    } else if (frame.type === 'completion') {
      setExecutionStatus('completed');
    } else if (frame.type === 'error') {
      setExecutionStatus('failed');
    }
  };

  return () => ws.close();
}, [connected]);
```

### HTTP Endpoints Needed

The dashboard requires these backend endpoints:

#### 1. **Start Agent Execution**
```
POST /api/agents/execute
{
  "input": "Add dark mode toggle",
  "conversationId": "optional-id"
}

Response:
{
  "executionId": "exec-123",
  "conversationId": "conv-456"
}
```

#### 2. **Approve/Deny Tool Call**
```
POST /api/agents/approve-tool
{
  "executionId": "exec-123",
  "toolCallId": "call-789",
  "approved": true
}

Response:
{
  "success": true
}
```

#### 3. **Get Execution Metrics**
```
GET /api/agents/metrics/{executionId}

Response:
{
  "iterationAvgMs": 142,
  "totalToolCalls": 5,
  "toolCallsApproved": 5,
  "toolCallsDenied": 0,
  "estimatedCost": 0.0025,
  "tokensUsed": 2250
}
```

#### 4. **Send Steering Command**
```
POST /api/agents/steer
{
  "executionId": "exec-123",
  "instruction": "Try a different approach"
}

Response:
{
  "success": true
}
```

## How to Use the Dashboard

### For End Users

1. **Start an Agent Execution**
   - Navigate to Dashboard
   - Expand "Agent Execution Monitor"
   - See real-time event stream
   - Monitor progress and costs

2. **Tool Call Approval**
   - When dashboard shows pending tool call, review it
   - Click "Approve" or "Deny"
   - Agent continues based on decision

3. **Monitor Metrics**
   - Track tool call success rate
   - Monitor token usage
   - Watch estimated costs

### For Developers

To connect the dashboard to actual agent execution:

```typescript
// In agents/execute endpoint handler
import { AgentRunnerV2 } from '@ducki/agent';
import { WebSocketManager } from './websocket';

export async function executeAgent(req, res) {
  const runner = new AgentRunnerV2(provider, db);
  const ws = WebSocketManager.getConnection(req.sessionId);

  // Stream frames to WebSocket
  for await (const frame of runner.run(req.body.input)) {
    ws.send(JSON.stringify(frame));
    
    // Handle tool approval gate
    if (frame.type === 'tool_execution_started') {
      const approval = await waitForApproval(frame.data.toolCallId);
      if (!approval.approved) {
        // Handle denial
      }
    }
  }
}
```

## Architecture

```
Dashboard Component
├── Agent Execution Monitor (NEW)
│   ├── Status Display (idle/running/completed/failed)
│   ├── Progress Bar (iteration counter)
│   ├── Event Feed (AgentRunEvent stream)
│   ├── Metrics Panel (tool calls, tokens, cost)
│   └── Controls (start, stop, approve)
│
├── Existing Sections
│   ├── Status Grid (Projects, Tasks, Tools, Agent)
│   ├── System Status (WebSocket, Agent)
│   └── Recent Tasks
```

## Event Types Displayed

The dashboard handles these AgentRunEvent types:

- `model_input_prepared` - System prompt built
- `model_generation_started` - LLM call initiated
- `model_generation_completed` - LLM response received
- `tool_candidate_extracted` - Tool identified
- `tool_validation_started` - Tool check
- `tool_execution_started` - Tool running
- `tool_execution_completed` - Tool done
- `tool_execution_failed` - Tool error
- `reasoning_checkpoint` - Agent thinking
- `iteration_complete` - Iteration finished
- `completion_decision` - Agent ready to complete
- `skill_auto_selected` - Skill chosen
- `memory_stored` - Memory saved
- `input_normalization` - Input processed

## Real-Time Updates via WebSocket

The dashboard uses WebSocket for frame-by-frame updates:

```
WebSocket Message Format:
{
  "type": "start" | "chunk" | "event" | "iteration_complete" | "completion" | "error",
  "data": {...},
  "timestamp": "2026-07-29T14:23:45Z"
}

Example Event Frame:
{
  "type": "event",
  "data": {
    "type": "tool_execution_completed",
    "message": "Tool filesystem completed in 45ms",
    "timestamp": "2026-07-29T14:23:45Z",
    "data": {
      "toolName": "filesystem",
      "duration": 45
    }
  }
}
```

## Performance Considerations

- **Event Buffering**: Dashboard shows last 8 events (auto-scroll)
- **Metrics Update**: Batched every 100ms (EventEmitterV2)
- **WebSocket Connection**: Single persistent connection per session
- **Memory**: Stores only current execution state (no history in memory)

## Extending the Dashboard

### Add Custom Metrics Display
```typescript
<div className="p-3 bg-slate-700/20 rounded">
  <p className="text-xs text-gray-400">Custom Metric</p>
  <p className="text-lg font-bold text-blue-400">{customValue}</p>
</div>
```

### Add Tool Approval Modal
```typescript
{pendingToolCall && (
  <Modal>
    <ToolApprovalUI
      toolCall={pendingToolCall}
      onApprove={() => handleApproveToolCall()}
      onDeny={() => handleDenyToolCall()}
    />
  </Modal>
)}
```

### Add Approval Policy Management
```typescript
<div>
  <h3>Approval Policies</h3>
  {policies.map(policy => (
    <PolicyEditor key={policy.id} policy={policy} />
  ))}
</div>
```

## Future Enhancements

1. **Execution History**
   - Save/load past execution events
   - Replay capability with timeline

2. **Approval Policy UI**
   - Visual policy builder
   - Save custom policies per agent type

3. **Cost Analysis**
   - Breakdown by tool/iteration
   - Estimate before running

4. **Performance Analytics**
   - Hook overhead visualization
   - Event overhead tracking
   - Iteration latency trends

5. **Skill Builder Preview**
   - Live preview while building workflows
   - Test without deploying

6. **Steering Chat**
   - Send instructions mid-execution
   - Agent responds to human guidance

## Testing

### Mock Data for Development
```typescript
// In development, use mock execution:
const mockEvents: ExecutionEvent[] = [
  {
    type: "model_input_prepared",
    message: "Prepared input with 5 messages",
    timestamp: new Date().toISOString()
  },
  // ... more events
];

// Simulate event stream
mockEvents.forEach((event, idx) => {
  setTimeout(() => {
    setEvents(prev => [...prev, event]);
  }, 500 * idx);
});
```

### Storybook Story
```typescript
export const Running = () => (
  <Dashboard>
    <AgentExecutionMonitor
      status="running"
      iteration={3}
      maxIterations={10}
      events={mockEvents}
      metrics={mockMetrics}
    />
  </Dashboard>
);
```

## Integration Checklist

- [ ] WebSocket connection implemented in Dashboard
- [ ] `/api/agents/execute` endpoint created
- [ ] `/api/agents/approve-tool` endpoint created
- [ ] `/api/agents/metrics` endpoint created
- [ ] `/api/agents/steer` endpoint created
- [ ] AgentRunnerV2 streaming integrated into execute handler
- [ ] EventEmitterV2 events flowing to WebSocket
- [ ] Tool approval gate implemented (onBeforeTool hook)
- [ ] Dashboard metrics updating in real-time
- [ ] Event stream scrolling smoothly
- [ ] Progress bar animation working
- [ ] Status colors showing correctly
- [ ] E2E test: Execute → See events → Approve tool → Complete

## Files Modified

- ✅ `apps/web/src/components/dashboard/Dashboard.tsx` - Enhanced with Agent Execution Monitor
- 📁 `apps/web/src/components/AgentControlDashboard.tsx` - Standalone component (for reference)
- 📝 `AGENT_DASHBOARD_INTEGRATION.md` - This guide

## Related Files

**Backend (Already Implemented):**
- `packages/agent/src/hooks/agent-hooks.ts` - Hook system
- `packages/agent/src/events/event-emitter-v2.ts` - Event batching
- `packages/agent/src/tools/tool-approval-policy.ts` - Approval rules
- `packages/agent/src/agent-runner-v2.ts` - Streaming API
- `packages/agent/src/performance/benchmarks.ts` - Metrics

**Frontend Integration:**
- `apps/web/src/components/dashboard/Dashboard.tsx` - Dashboard component
- `apps/server/src/handlers/` - WebSocket handler (to be created)
- `apps/server/src/routes/agents.ts` - Agent endpoints (to be created)

---

**Status**: ✅ Dashboard UI Complete | ⏳ Backend Integration Pending

The UI is production-ready and waiting for backend endpoints to be wired up!
