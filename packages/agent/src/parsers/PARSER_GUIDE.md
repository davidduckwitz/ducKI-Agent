# Think Block Parser Guide

## Overview

The `ThinkBlockParser` extracts and structures thinking/reasoning blocks from LLM outputs. It supports multiple formats and automatically identifies tool references and reasoning depth.

## Usage

```typescript
import { ThinkBlockParser } from "@ducki/agent/parsers";

const parser = new ThinkBlockParser();
const result = parser.parse(llmOutput);

console.log({
  thinkBlocks: result.thinkBlocks,
  remainingContent: result.remainingContent,
  statistics: result.statistics,
});
```

## Supported Formats

### 1. XML Format
```xml
<think>Internal reasoning here</think>
<ant>Anthropic format thinking</ant>
```

### 2. Markdown Format
````markdown
```thinking
Internal reasoning
in markdown format
```
````

### 3. Custom Format
```
[THINKING]Internal reasoning[/THINKING]
```

## Output Structure

### ThinkBlock Interface

```typescript
interface ThinkBlock {
  // Unique identifier
  id: string;
  
  // Raw thinking content
  content: string;
  
  // Timestamps
  startTime: Date;
  endTime?: Date;
  
  // Extracted tool calls
  toolCalls: ToolCallReference[];
  
  // Reasoning depth estimation (shallow/medium/deep)
  thinkingDepth: "shallow" | "medium" | "deep";
  
  // Estimated token count
  tokenEstimate?: number;
  
  // Parsing status
  status: "streaming" | "complete";
}
```

### ToolCallReference Interface

```typescript
interface ToolCallReference {
  // Position in content where mentioned
  position: number;
  
  // Tool name (e.g., "shell", "browser")
  toolName: string;
  
  // What the tool is supposed to do
  purpose: string;
  
  // Status (in think blocks, always "planned")
  status: "planned" | "executing" | "completed" | "failed";
  
  // Confidence level (0-1)
  confidence: number;
}
```

### ParseResult Interface

```typescript
interface ParseResult {
  // All extracted think blocks
  thinkBlocks: ThinkBlock[];
  
  // Content with think blocks removed
  remainingContent: string;
  
  // Aggregated statistics
  statistics: {
    totalThinkTokens: number;
    totalToolRefs: number;
    thinkingDepth: "shallow" | "medium" | "deep";
  };
}
```

## Example Output

### Input
```
I need to analyze this problem.

<think>
Let me break this down:
1. I should call the shell to check what files are available
2. Then I'll call the browser to take a screenshot of the result
3. Based on that, I'll decide on the next action

This approach seems sound because it gives me visibility into the system state.
</think>

So my plan is ready.
```

### Output
```json
{
  "thinkBlocks": [
    {
      "id": "think_1725350000000_abc1234",
      "content": "Let me break this down:\n1. I should call the shell to check what files are available\n2. Then I'll call the browser to take a screenshot of the result\n3. Based on that, I'll decide on the next action\n\nThis approach seems sound because it gives me visibility into the system state.",
      "startTime": "2025-08-02T16:47:52.000Z",
      "endTime": null,
      "toolCalls": [
        {
          "position": 85,
          "toolName": "shell",
          "purpose": "check what files are available",
          "status": "planned",
          "confidence": 0.9
        },
        {
          "position": 165,
          "toolName": "browser",
          "purpose": "take a screenshot of the result",
          "status": "planned",
          "confidence": 0.9
        }
      ],
      "thinkingDepth": "medium",
      "tokenEstimate": 65,
      "status": "streaming"
    }
  ],
  "remainingContent": "I need to analyze this problem.\n\nSo my plan is ready.",
  "statistics": {
    "totalThinkTokens": 65,
    "totalToolRefs": 2,
    "thinkingDepth": "medium"
  }
}
```

## Thinking Depth Classification

The parser estimates reasoning depth based on token count:

- **Shallow** (< 50 tokens / < 200 chars)
  - Quick decisions: "OK, I'll do it this way"
  - Immediate judgments
  - No multi-step analysis

- **Medium** (50-300 tokens / 200-1200 chars)
  - Multi-step reasoning
  - Consideration of alternatives
  - Structured planning

- **Deep** (> 300 tokens / > 1200 chars)
  - Extensive analysis
  - Multiple perspectives
  - Complex trade-off evaluation

## Tool Reference Detection

The parser recognizes these patterns:

### German Patterns
- "rufe X auf um Y" (call X to Y)
- "verwende tool: X" (use tool X)
- "nutze X um Y" (use X to Y)

### English Patterns
- "call X to Y" / "call the X to Y"
- "use X to Y" / "use the X for Y"
- "invoke X to Y"

Each detected tool call has a **confidence score**:
- **0.9**: High-confidence patterns ("rufe X auf", "call X to")
- **0.85**: Medium patterns ("verwende tool: X")
- **0.75**: Looser patterns ("nutze X", "use X for Y")

## Integration with Events

Think blocks can be attached to agent events in `eventData`:

```typescript
const event: AgentRunEvent = {
  type: "reasoning",
  message: "Agent is thinking about next action",
  data: {
    thinking: "Raw thinking string",
    thinkBlocks: result.thinkBlocks, // Parsed structure
    statistics: result.statistics,
  },
};
```

## Token Estimation

The parser uses a simple heuristic: **1 token ≈ 4 characters**.

This is a rough estimate and should not be used for billing. For accurate token counts, use the LLM provider's official token counter.

## Streaming Support

In Phase 2, the parser will support streaming mode:
- Process think blocks as they arrive incrementally
- Update `status` to "complete" when closing tag is received
- Support for partial tool references in streaming context

## Performance

- Single-pass regex-based parsing
- No backtracking or complex lookahead
- Optimized for typical 1-10 think block documents
- Lenient parsing mode: malformed tags are skipped gracefully
