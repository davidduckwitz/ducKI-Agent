# Agent Reflection System - Complete Guide

## Overview

The Reflection system provides **automated quality evaluation and self-improvement** of agent responses. The agent can evaluate its own output, identify issues, and iteratively improve responses.

**Goal**: Improve response quality without external feedback loops.

---

## How Reflection Works

### Basic Flow

```
1. Agent generates response (finalResponse)
2. If enableReflection=true:
   ├─ Evaluate: Call reflection.evaluate() to assess quality
   ├─ Identify: LLM identifies issues and suggests improvements
   ├─ Improve: If shouldRetry=true, use improved response
   └─ Retry: Loop up to reflectionMaxRetries times
3. If reflectionMetaReview=true:
   ├─ Meta-Evaluate: Run second reflection on improved response
   └─ Validate: Ensure improvements are solid
4. If reflectionStoreMemory=true:
   └─ Learn: Store quality insights in long-term memory for future learning
```

### Quality Levels

Each reflection evaluation returns a quality level:

- **poor**: Response has significant issues or is missing key information
- **adequate**: Response works but could be improved
- **good**: Response is useful and mostly correct
- **excellent**: Response fully addresses the request, no improvements needed

---

## Configuration

### Settings

All settings use environment variables or the Settings UI. They are read at Agent startup.

#### `AGENT_ENABLE_REFLECTION` (boolean, default: true)

Enable/disable reflection entirely.

- `true`: Reflection enabled in full mode (disabled in lightweight/chatbot)
- `false`: No reflection at any time

**When to use**:
- ✅ `true` for production (improves quality)
- ❌ `false` only if you need maximum speed over quality

#### `AGENT_REFLECTION_MAX_RETRIES` (number, default: 1, range: 0-3)

Maximum improvement attempts per response.

- `0`: Reflection disabled (quick, but no self-correction)
- `1`: **Recommended** - one improvement attempt (good quality/speed tradeoff)
- `2`: Two improvement attempts (higher quality, slower)
- `3`: Three improvement attempts (maximum quality, slowest)

**Cost per retry**: ~200-500 tokens + ~200-400ms latency

**When to use**:
- `1` for normal operations (best balance)
- `2-3` for critical/complex responses where quality is more important than speed
- `0` if speed is critical and reflection overhead is unacceptable

#### `AGENT_REFLECTION_META_REVIEW` (boolean, default: false)

Run a **second reflection** after the initial improvement attempts.

Meta-review validates the already-improved response and catches edge cases that initial reflection might miss.

- `true`: Run additional validation (costs +1 LLM call)
- `false`: Skip meta-review (faster)

**When to use**:
- ✅ `true` for critical tasks (contract reviews, code analysis)
- ❌ `false` for normal conversations (not worth the extra cost)

#### `AGENT_REFLECTION_POST_ITERATION` (boolean, default: true)

Run quality assessment **after** the normal iteration loop completes.

When the agent reaches `maxIterations`, reflection can still evaluate the final response for quality and learning purposes (but cannot improve it - too late).

- `true`: Assess quality and store learnings from boundary cases
- `false`: Skip post-iteration assessment

**Purpose**:
- Help agent learn **from its own limitations** (what happens when iterations run out?)
- Understand which response types struggle at iteration boundaries
- Improve future responses by recognizing patterns

**Cost**: +1 LLM call (~200-400ms) only at end of run when iterations exhausted

**When to use**:
- ✅ `true` for learning-focused agents (improves over time)
- ✅ `true` for monitoring (know which queries hit iteration limits)
- ❌ `false` only if speed is absolutely critical

#### `AGENT_REFLECTION_POST_ITERATION_MIN_QUALITY` (enum, default: "adequate")

Store post-iteration learnings only if quality falls at or below this level.

Prevents cluttering memory with learnings from already-good responses.

- `"poor"`: Store whenever quality is poor (most aggressive learning)
- `"adequate"`: Store if quality ≤ adequate (recommended, good balance)
- `"good"`: Store only if quality ≤ good (conservative, only major issues)
- `"excellent"`: Never store (disabled)

**How it works**:

```
Post-iteration assessment happens
  ↓
Check: quality <= minQuality?
  ├─ YES: Store learnings in memory ("pending" review)
  └─ NO: Skip (response was good enough already)
```

**When to adjust**:
- `"poor"` if you want **maximum learning** (all failures matter)
- `"adequate"` for **balanced approach** (catch most issues)
- `"good"` if you only care about **major failures**
- `"excellent"` to **disable post-iteration learning**

#### `AGENT_REFLECTION_STORE_MEMORY` (boolean, default: false)

Store reflection findings in long-term memory for **learning over time**.

Stores quality insights (issues found, suggestions) as "pending" memory entries that help the agent recognize and avoid similar issues in future conversations.

- `true`: Enable learning from reflections
- `false`: Disable learning (faster, but no improvement over time)

**When to use**:
- ✅ `true` if you want agent to learn from its own evaluations
- ❌ `false` if you prefer stateless operation or want to manually review learnings

---

## Reflection in Different Agent Modes

### Full Mode

**Status**: ✅ Reflection fully enabled

- Reflection configured based on settings
- Default: `enableReflection=true`, `reflectionMaxRetries=1`
- Can attempt up to 50 iterations total
- Reflection adds minimal overhead (1-3 extra LLM calls out of 50)

**Why**:
- Plenty of iteration budget available (50 max)
- Reflection cost is negligible as percentage of total
- Quality improvement is worth the small latency cost

### Lightweight Mode

**Status**: ⛔ Reflection disabled

- `enableReflection` forced to `false`
- `reflectionMaxRetries` forced to `0`
- Only 5 iterations available total

**Why**:
- Lightweight mode optimizes for **speed on simple queries**
- Reflection would consume ~20% of iteration budget (1 out of 5)
- Trade-off: Prioritize responsiveness over self-correction
- Simple queries typically don't need reflection

**Future Improvement**:
- Could allow `reflectionMaxRetries=0` (evaluate only, no retry) to get quality feedback without consuming iterations
- Not yet implemented, would require testing

### Chatbot Mode

**Status**: ⛔ Reflection disabled

- `enableReflection` forced to `false`
- `reflectionMaxRetries` forced to `0`
- Only 1-4 iterations available total (depends on query type)

**Why**:
- Chatbot mode is for **minimal interaction** (quick yes/no answers)
- Barely enough iterations for tool call + response
- Reflection would consume the entire iteration budget
- Trade-off: Speed and simplicity over quality

### Post-Iteration Assessment

**Special Case**: Even in all modes, post-iteration assessment can run **after** `maxIterations` is reached.

**Why**:
- Normal reflection tries to improve response within iteration budget
- Post-iteration assessment **cannot improve** (too late), only evaluate for learning
- Costs only +1 LLM call at the **end** of run (outside iteration loop)
- Helps agent understand quality at iteration **boundaries**

**Example Flow**:
```
Iteration 1: Generate + Tool call
Iteration 2: Process tool result + Reflection
Iteration 3: Regenerate + More Reflection
...
Iteration 50: Final response (maxIterations reached)
│
└─ AFTER Loop: Post-iteration assessment runs
   └─ Evaluates: "Is this response good?"
   └─ Stores: Quality insights for learning (even if poor)
   └─ No improvement applied (response already returned)
```

**Benefit**: Agent learns from responses that **couldn't be improved** due to iteration limits. Over time, recognizes patterns like "browser automation queries often hit iteration limits" and can plan differently.

---

## Performance Impact

### Time Cost

Each reflection pass adds:

| Component | Latency |
|-----------|---------|
| Reflection.evaluate() call | 200-400ms (typical) |
| LLM processing | ~100-200ms |
| Parsing result | <10ms |
| **Total per reflection** | **200-400ms** |

Examples:
- `reflectionMaxRetries=1` (1 evaluation): +200-400ms
- `reflectionMaxRetries=2` (2 evaluations): +400-800ms
- `reflectionMetaReview=true` (additional): +200-400ms more

### Token Cost

Each reflection pass uses:

| Component | Tokens |
|-----------|--------|
| System prompt (evaluation instructions) | ~150 tokens |
| Request + context | ~100-200 tokens |
| Response (quality + issues + suggestions) | ~200-300 tokens |
| **Total per reflection** | **~400-650 tokens** |

Examples:
- `reflectionMaxRetries=1`: +400-650 tokens
- `reflectionMaxRetries=2`: +800-1300 tokens
- `reflectionMetaReview=true`: +400-650 tokens more

### Summary

**Typical full-mode run**:
- User query → 5-10 iterations total
- With `reflectionMaxRetries=1`: +1 LLM call, +400-650 tokens, +200-400ms
- Impact: ~10-15% slower, ~20-30% more tokens

**Full-mode with meta-review**:
- With `reflectionMetaReview=true`: +2 LLM calls, +800-1300 tokens, +400-800ms
- Impact: ~20-30% slower, ~40-60% more tokens

---

## How Reflection Improves Response Quality

### What Reflection Evaluates

Reflection assesses:
- ✅ Does response address the original request?
- ✅ Are there factual inaccuracies?
- ✅ Is the response clear and well-organized?
- ✅ Missing information or context?
- ✅ Tone/style appropriate for the request?

### Improvement Examples

**Example 1: Missing Context**
```
Original Request: "Explain REST APIs"

First Response:
"REST is an architectural style using HTTP methods."

Reflection Issues:
- Too brief, lacks practical examples
- No mention of key concepts (resources, endpoints, status codes)

Improved Response:
"REST (Representational State Transfer) is an architectural style for APIs 
using standard HTTP methods (GET, POST, PUT, DELETE) to manipulate resources. 
For example, GET /users retrieves users, POST /users creates one, etc..."
```

**Example 2: Clarity Issues**
```
Original Request: "How do I deploy this app?"

First Response:
"Use Docker. Build image with Dockerfile. Push to registry. Deploy with kubectl."

Reflection Issues:
- Assumes familiarity with Docker/Kubernetes
- Jumps between tools without context
- No prerequisites or alternatives

Improved Response:
"To deploy, you have two options:
1. Docker (Recommended for most projects):
   - Install Docker, create Dockerfile
   - Build: docker build -t app .
   - Run: docker run -p 8000:8000 app

2. Direct installation:
   - Install Python 3.8+
   - Run: python -m venv venv && pip install -r requirements.txt
..."
```

---

## Best Practices

### When to Enable Reflection

✅ **Enable** (`enableReflection=true`) for:
- Production systems where response quality matters
- Complex technical questions
- Tasks requiring verification
- Scenarios where a bad response is costly

❌ **Disable** (`enableReflection=false`) for:
- Speed-critical operations
- Lightweight/chatbot modes (auto-disabled anyway)
- High-volume, simple queries
- When network/compute is constrained

### Recommended Configurations

#### Default (Good Balance)
```
AGENT_ENABLE_REFLECTION=true
AGENT_REFLECTION_MAX_RETRIES=1              # One improvement attempt
AGENT_REFLECTION_META_REVIEW=false          # Skip extra validation
AGENT_REFLECTION_STORE_MEMORY=false         # No learning overhead
AGENT_REFLECTION_POST_ITERATION=true        # Learn from boundaries
AGENT_REFLECTION_POST_ITERATION_MIN_QUALITY=adequate
```
**Result**: ~10-15% slower, ~20-30% more tokens, better quality + boundary learning

#### Quality-First (Critical Tasks)
```
AGENT_ENABLE_REFLECTION=true
AGENT_REFLECTION_MAX_RETRIES=2              # Up to 2 improvement attempts
AGENT_REFLECTION_META_REVIEW=true           # Validate improvements
AGENT_REFLECTION_STORE_MEMORY=true          # Learn over time
AGENT_REFLECTION_POST_ITERATION=true        # Boundary assessment
AGENT_REFLECTION_POST_ITERATION_MIN_QUALITY=poor  # Learn from all issues
```
**Result**: ~30-40% slower, ~60-100% more tokens, highest quality + comprehensive learning

#### Speed-First (Simple Queries)
```
AGENT_ENABLE_REFLECTION=false               # Disable reflection
AGENT_REFLECTION_POST_ITERATION=false       # Skip boundary assessment
# (or rely on lightweight mode auto-disable)
```
**Result**: Fastest possible, no quality overhead

#### Learning-Focused (Continuous Improvement)
```
AGENT_ENABLE_REFLECTION=true
AGENT_REFLECTION_MAX_RETRIES=1
AGENT_REFLECTION_STORE_MEMORY=true          # Learn from reflections
AGENT_REFLECTION_POST_ITERATION=true        # Learn from boundaries
AGENT_REFLECTION_POST_ITERATION_MIN_QUALITY=adequate
```
**Result**: ~15-20% slower, but agent continuously improves over many conversations through memory

---

## Troubleshooting

### Problem: Reflection Makes Responses Slower

**Cause**: Each reflection adds 200-400ms latency

**Solutions**:
- Reduce `AGENT_REFLECTION_MAX_RETRIES` to 0-1 (avoid 2-3)
- Disable `AGENT_REFLECTION_META_REVIEW`
- Use lightweight mode for simple queries (auto-disables reflection)

### Problem: High Token Usage

**Cause**: Each reflection uses 400-650 tokens

**Solutions**:
- Disable reflection if token budget is tight
- Reduce `AGENT_REFLECTION_MAX_RETRIES`
- Disable `AGENT_REFLECTION_META_REVIEW`

### Problem: Reflection Makes Response Worse

**Cause**: Rare, but LLM can misunderstand evaluation prompt or "improve" in wrong direction

**Solutions**:
- Reduce `AGENT_REFLECTION_MAX_RETRIES` (limit damage)
- Disable `AGENT_REFLECTION_META_REVIEW` if it's making things worse
- Check if specific types of queries are affected
- Report issue if pattern detected

### Problem: Memory Getting Filled with Reflection Learnings

**Cause**: `AGENT_REFLECTION_STORE_MEMORY=true` and memory review is pending

**Solutions**:
- Review and approve/reject pending memory entries in Memory Browser
- Disable `AGENT_REFLECTION_STORE_MEMORY` if learnings aren't useful
- Clear pending entries periodically

---

## Technical Details

### Reflection Evaluation Prompt

The system prompt used for evaluations:

```
You are a quality evaluation assistant. Evaluate the agent's response and return JSON:
{
  "quality": "poor|adequate|good|excellent",
  "issues": ["list of specific issues found"],
  "suggestions": ["list of concrete improvements"],
  "shouldRetry": boolean,
  "improvedResponse": "optional improved version (only if shouldRetry=true and changes made)"
}

Guidelines:
- quality: Assess how well the response addresses the original request
- shouldRetry: true only if you can meaningfully improve the response
- improvedResponse: Provide only if you have concrete improvements to suggest
```

**Temperature**: 0.2 (very deterministic, consistent evaluations)
**Max tokens**: 1000 per evaluation

### Reflection Loop Logic

```typescript
for (let attempt = 1; attempt <= reflectionMaxRetries; attempt++) {
  // 1. Evaluate current response
  const result = reflection.evaluate(userRequest, response);
  
  // 2. Check if improvement is needed and possible
  if (!result.shouldRetry) break; // Quality is good
  
  if (!result.improvedResponse || result.improvedResponse === response) {
    break; // No improvement offered or same as current
  }
  
  // 3. Apply improvement and loop to next attempt
  response = result.improvedResponse;
}
```

This prevents:
- ✅ Infinite loops (stops after reflectionMaxRetries)
- ✅ Pointless retries (stops if shouldRetry=false or no change)
- ✅ Degradation (only applies improvements that are different)

---

## Files Modified

### Core Implementation
- `packages/agent/src/reflection/reflection.ts` - Reflection class with documentation
- `packages/agent/src/agent.ts` - Reflection loop integration + mode-based disabling
- `packages/agent/src/config/interfaces_types.ts` - Detailed parameter documentation

### Settings
- `apps/web/src/components/settings/Settings.tsx` - UI for all reflection settings

---

## Future Improvements

### Potential Enhancements

1. **Lightweight Mode Reflection**
   - Allow `enableReflection=true` in lightweight mode
   - Use `reflectionMaxRetries=0` (evaluate-only, no retry)
   - Get quality feedback without consuming iterations

2. **Adaptive Reflection**
   - Auto-enable/disable based on response length or complexity
   - Enable reflection only for responses > 500 chars
   - Skip for simple answers (e.g., "yes"/"no")

3. **Reflection Hints**
   - Include user-specific preferences in evaluation context
   - E.g., "user prefers examples" → evaluation checks for examples

4. **Reflection Caching**
   - Cache reflections for similar questions
   - Reuse quality insights without re-evaluating

5. **Per-Tool Reflection**
   - Different reflection strategies for different tool outputs
   - E.g., stricter evaluation for shell commands than general text

---

## Summary

Reflection is a powerful self-improvement mechanism that:

✅ **Improves Quality**: Iteratively fixes issues in responses
✅ **Builds Confidence**: Meta-review validates improvements
✅ **Enables Learning**: Stores insights for future use
✅ **Configurable**: Flexible settings for different use cases

**Recommended Settings**:
- Default: `enableReflection=true`, `reflectionMaxRetries=1`
- Override only if speed/token budget is critical

**Impact**:
- +200-400ms per reflection (negligible in most scenarios)
- +400-650 tokens per reflection
- Noticeable improvement in response quality

For questions or issues, check the configuration options or consult the code comments.
