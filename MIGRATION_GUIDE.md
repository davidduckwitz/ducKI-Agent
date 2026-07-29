# DucKI Agent: Feature Parity Migration Guide

## Overview

This guide documents the migration of the ducKI Agent (Node.js) to achieve feature parity with the Hermes Agent (Python). The implementation spans 6 phases of architecture, implementation, and testing.

## Project Phases

### Phase 1: Multi-Provider LLM System & Error Classification ✅
**Goal:** Support multiple LLM providers with intelligent error recovery.

**Components:**
- **ProviderRouter**: Routes requests across Anthropic, Google Gemini, AWS Bedrock, and local models
- **ErrorClassifier**: 9-level classification system for error recovery decisions
- **Adapter Pattern**: Provider-agnostic interface for all LLM interactions

**Key Features:**
- Intelligent error recovery based on error type
- Provider-specific timeout and retry handling
- Extended thinking support (Anthropic)
- Cost tracking per provider

**Files:**
- `packages/providers/src/adapters/` - Provider implementations
- `packages/agent/src/executor/error-classifier.ts` - Error handling logic
- `packages/providers/src/provider-router.ts` - Request routing

**Usage:**
```typescript
import { ProviderRouter } from "@ducki/providers";

const router = new ProviderRouter(providers);
const response = await router.route(messages, { temperature: 0.7 });
```

---

### Phase 2: Credential Management & Provider Failover ✅
**Goal:** Manage multiple credentials per provider with automatic failover.

**Components:**
- **CredentialManager**: Multi-credential support with rotation
- **CredentialAwareRouter**: Integrates credentials with provider selection
- **Rotation Strategies**: Automatic, manual, and scheduled rotation

**Key Features:**
- Active/fallback credential chains
- Failure tracking per credential
- Automatic rotation on auth errors
- Secure credential storage (database)
- Credential masking in logs/UI

**Files:**
- `packages/providers/src/credential-manager.ts` - Credential lifecycle
- `packages/providers/src/adapters/credential-aware-router.ts` - Integration
- `apps/server/src/routes/credentials.ts` - REST API
- `apps/web/src/components/settings/CredentialManagementSettings.tsx` - UI

**Usage:**
```typescript
import { credentialManager } from "@ducki/providers";

// Add credential
await credentialManager.addCredential("anthropic", {
  displayName: "Primary Key",
  secretKey: "sk-...",
});

// Enable rotation
credentialManager.enableAutoRotation("anthropic", {
  rotationInterval: 3600000,
  maxRotationsPerDay: 3,
});
```

---

### Phase 3: Context Compression & Memory Optimization ✅
**Goal:** Manage conversation context with intelligent token budgeting.

**Components:**
- **TokenCounter**: Model-specific token counting and budgeting
- **ContextManager**: Conversation pruning with multiple strategies
- **Pruning Strategies**: Oldest-first, least-important, summary-based, sliding-window

**Key Features:**
- Approximate token counting (word-to-token ratios)
- Context budget calculation with output reserve
- Multiple pruning algorithms
- Summary generation for old messages
- Cost estimation per provider

**Files:**
- `packages/agent/src/context/token-counter.ts` - Token management
- `packages/agent/src/context/context-manager.ts` - Context optimization
- Support for 10+ models (Claude, Gemini, GPT-4, Bedrock, local)

**Usage:**
```typescript
import { ContextManager } from "@ducki/agent";

const manager = new ContextManager("claude-3-5-sonnet", {
  pruningStrategy: "sliding-window",
  compressionThreshold: 80,
});

manager.addMessages(conversationHistory);
const optimized = manager.optimizeForContext();
```

---

### Phase 1c & 1d: Settings API, Database & UI Implementation ✅
**Goal:** Persist and manage agent configuration with UI control.

**Components:**
- **ProviderSettingsService**: Database persistence for all settings
- **Settings API**: REST endpoints for configuration
- **ProviderConfigSettings UI**: 24 configurable settings across 6 categories
- **Runtime Controls**: Environment variable → database → default cascade

**Key Features:**
- Settings cascade: env vars → database → Zod defaults
- Real-time validation and feedback
- Export/import functionality
- Per-provider configuration
- Global settings override capability

**Settings Categories:**
1. **Error Handling** - retry logic, compression thresholds
2. **Provider Failover** - strategy, health checks
3. **Anthropic Config** - timeouts, extended thinking
4. **Gemini Config** - safety thresholds
5. **Bedrock Config** - region, instance type
6. **Global Settings** - fallback behavior, debug flags

**Files:**
- `packages/agent/src/config/provider-settings.ts` - Zod schemas
- `packages/agent/src/config/load-runtime-controls.ts` - Loading logic
- `apps/server/src/lib/provider-settings-service.ts` - Database layer
- `apps/web/src/components/settings/ProviderConfigSettings.tsx` - UI

**Usage:**
```typescript
import { loadAgentRuntimeControls } from "@ducki/agent";

const controls = await loadAgentRuntimeControls(database);
// All settings now available as typed objects
```

---

### Phase 4: Skill Bundles & Advanced Features ✅
**Goal:** Intelligent skill selection based on context and usage patterns.

**Components:**
- **SkillBundleManager**: Theme-based skill grouping
- **AdvancedSkillSelector**: Context-aware intelligent selection
- **SkillsManagementSettings UI**: Full CRUD for bundles

**Key Features:**
- 7 predefined skill bundles (web-dev, backend, devops, data-analysis, automation, code-review, documentation)
- Bundle attributes: priority, dependencies, min required, max concurrent
- Context-aware selection (task type, complexity, time constraint)
- Bundle dependency resolution
- Concurrent skill limiting per bundle
- Skill management in bundles (comma-separated input)

**Skill Bundles:**
1. **Web Development** - frontend, React, TypeScript, HTML, CSS
2. **Backend Development** - Node.js, database, API, server
3. **DevOps & Infrastructure** - Docker, K8s, CI/CD, cloud
4. **Data Analysis** - SQL, Python, statistics, visualization
5. **Automation & Scripting** - bash, workflow, robotics
6. **Code Quality & Review** - testing, linting, debugging
7. **Documentation** - writing, markdown, API docs

**Files:**
- `packages/agent/src/skill-selector/skill-bundle.ts` - Bundle management
- `packages/agent/src/skill-selector/advanced-selector.ts` - Intelligent selection
- `apps/web/src/components/settings/SkillsManagementSettings.tsx` - UI (full CRUD)

**Usage:**
```typescript
import { SkillBundleManager, AdvancedSkillSelector } from "@ducki/agent";

const selector = new AdvancedSkillSelector();
const result = selector.selectSkills({
  userInput: "Build a React component",
  taskType: "development",
  complexityLevel: "moderate",
});

console.log(result.selectedSkills); // [SkillManifest, ...]
console.log(result.reasoning);       // Why these skills selected
console.log(result.confidence);      // 0-1 confidence score
```

---

### Phase 5: Integration & Testing ✅
**Goal:** End-to-end integration with comprehensive testing.

**Components:**
- **SkillSelectionService**: Unified skill selection API
- **Integration Tests**: 27 test cases covering all components
- **Multi-component scenarios**: Skills + context + settings working together

**Test Coverage:**
- Skill selection with context
- Metrics tracking (success rate, iterations)
- Token budgeting and context optimization
- Settings cascade validation
- Complex multi-turn scenarios
- Graceful degradation under load
- System resilience and error recovery

**Test Files:**
- `packages/agent/test/skill-integration.test.ts` - 11 tests
- `packages/agent/test/phase5-integration.test.ts` - 14 tests
- `packages/agent/test/multi-tool-integration.test.ts` - 2 tests

**Usage:**
```typescript
import { SkillSelectionService } from "@ducki/agent";

const service = new SkillSelectionService();
service.initialize(availableSkills);

const selection = service.selectSkills({
  userInput: userInput,
  taskType: "development",
  complexityLevel: "moderate",
});

// Record usage for metrics
service.recordUsage(selectedSkill.slug, success, iterations);
```

---

### Phase 6: Documentation & Migration Guide (This File) ✅
**Goal:** Complete documentation for migration path.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   User Input / Settings                  │
└────────────────────────┬────────────────────────────────┘
                         │
        ┌────────────────┴────────────────┐
        │                                 │
        ▼                                 ▼
┌─────────────────────┐         ┌──────────────────────┐
│ Skill Selection     │         │ Runtime Controls     │
│ (AdvancedSelector)  │         │ (Settings Cascade)   │
└────────────┬────────┘         └─────────┬────────────┘
             │                            │
             └────────────┬───────────────┘
                          │
                          ▼
            ┌─────────────────────────────┐
            │   Agent Execution Loop      │
            │  (Load skills, tools, ctx)  │
            └─────────────┬───────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Provider     │  │ Error        │  │ Context      │
│ Router       │  │ Classifier   │  │ Manager      │
│ (Multi-LLM)  │  │ (Recovery)   │  │ (Compress)   │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
        ┌────────────────┴────────────────┐
        │                                 │
        ▼                                 ▼
┌──────────────────┐           ┌──────────────────┐
│ Credential       │           │ Tool Execution   │
│ Manager          │           │ (Multi-tool)     │
│ (Failover)       │           │                  │
└──────────────────┘           └──────────────────┘
```

---

## Migration Checklist

### For ducKI Agent Administrators

- [ ] **Phase 1**: Configure provider credentials (Anthropic, Gemini, Bedrock, local)
- [ ] **Phase 2**: Set up credential management and rotation policies
- [ ] **Phase 3**: Configure context compression settings for your token budget
- [ ] **Phase 1c/1d**: Populate provider-specific settings in database or env vars
- [ ] **Phase 4**: Review and customize skill bundles for your use case
- [ ] **Phase 5**: Run end-to-end tests to verify integration
- [ ] **Phase 6**: Review this documentation and adjust settings as needed

### For ducKI Agent Developers

- [ ] Understand multi-provider architecture (Phase 1)
- [ ] Learn credential failover chains (Phase 2)
- [ ] Implement context optimization in your agent loop (Phase 3)
- [ ] Use settings cascade for configuration (Phase 1c/1d)
- [ ] Integrate skill selection for task-aware operations (Phase 4)
- [ ] Write integration tests using provided test patterns (Phase 5)

---

## Configuration Examples

### Environment Variables (Phase 1c/1d)

```bash
# Provider selection
export AGENT_DEFAULT_PROVIDER=anthropic
export AGENT_PROVIDER_ANTHROPIC_API_KEY=sk-ant-...
export AGENT_PROVIDER_GEMINI_API_KEY=...

# Auto-skill settings
export AGENT_AUTO_SKILL_SELECTION=true
export AGENT_AUTO_SKILL_THRESHOLD=0.78

# Context compression
export AGENT_COMPRESSION_STRATEGY=sliding-window
export AGENT_COMPRESSION_THRESHOLD=80
```

### Database Settings (via API)

```bash
# Set provider failover order
POST /api/settings
{
  "key": "provider_settings:agent",
  "value": {
    "providers": ["anthropic", "gemini", "bedrock", "local"],
    "credentials": {...}
  }
}

# Configure skill selection
PATCH /api/settings/provider_settings:agent
{
  "autoSkillSelection": true,
  "autoSkillScoreThreshold": 0.75
}
```

---

## Testing & Verification

### Run All Tests

```bash
npm run test
```

### Test Coverage by Phase

```bash
# Phase 1 & 2 (Providers & Credentials)
npm run test -- provider
npm run test -- credential

# Phase 3 (Context)
npm run test -- context

# Phase 4 (Skills)
npm run test -- skill-bundle
npm run test -- advanced-selector

# Phase 5 (Integration)
npm run test -- skill-integration
npm run test -- phase5-integration
```

### Integration Test Scenarios

All Phase 5 tests verify:
1. **Basic Integration**: Individual components working correctly
2. **Multi-component**: Skills + context + settings together
3. **Graceful Degradation**: Behavior under token budget pressure
4. **Metrics Tracking**: Success rates and performance data
5. **Error Recovery**: Handling missing or invalid data
6. **Configuration Cascade**: Settings flowing through the system

---

## Performance Tuning

### Token Budget Optimization

```typescript
// Aggressive compression (small token budget)
const manager = new ContextManager(model, {
  compressionThreshold: 60,    // Start compression earlier
  pruningStrategy: "summary-based",
  keepRecentMessages: 3,       // Keep fewer recent messages
  keepSystemMessage: true,
});

// Conservative (large token budget)
const manager = new ContextManager(model, {
  compressionThreshold: 90,    // Start compression later
  pruningStrategy: "sliding-window",
  keepRecentMessages: 10,      // Keep more messages
});
```

### Credential Rotation Tuning

```typescript
// High-security setup
const rotation = {
  rotationInterval: 3600000,    // 1 hour
  maxRotationsPerDay: 24,       // Every 1 hour
  backupCredentialsRequired: 2, // Always have backup
};

// Standard setup
const rotation = {
  rotationInterval: 86400000,   // 24 hours
  maxRotationsPerDay: 1,
  backupCredentialsRequired: 1,
};
```

### Skill Selection Tuning

```typescript
// Conservative (select fewer skills)
const config = {
  threshold: 0.85,        // Higher threshold
  margin: 0.3,            // Larger margin to 2nd place
  minInputLength: 50,     // Require longer input
  minOverlap: 5,          // Require more keyword overlap
};

// Aggressive (select more skills)
const config = {
  threshold: 0.60,        // Lower threshold
  margin: 0.1,            // Smaller margin
  minInputLength: 10,     // Accept shorter input
  minOverlap: 1,          // Less overlap required
};
```

---

## Troubleshooting

### Provider Not Responding

1. Check credential validity in database
2. Verify API key in environment variables
3. Check if credential is in active rotation chain
4. Review error logs in error-classifier output
5. Check network connectivity to provider

### Context Memory Exceeded

1. Lower `compressionThreshold` in ContextManager
2. Increase `keepRecentMessages` reduction
3. Switch to `summary-based` pruning strategy
4. Reduce `maxInputTokens` per request
5. Review token estimates for model

### Skill Selection Not Working

1. Verify skills are registered in AdvancedSkillSelector
2. Check `autoSkillSelection` is enabled in settings
3. Review `autoSkillScoreThreshold` (may be too high)
4. Verify user input length meets `autoSkillMinInputLength`
5. Check skill bundle setup and dependencies

---

## Summary of Changes

| Phase | Component | Lines | Status |
|-------|-----------|-------|--------|
| 1 | ProviderRouter, ErrorClassifier | 1500+ | ✅ Complete |
| 2 | CredentialManager, CredentialAwareRouter | 800+ | ✅ Complete |
| 3 | TokenCounter, ContextManager | 900+ | ✅ Complete |
| 1c/1d | Settings Service, API, UI | 1200+ | ✅ Complete |
| 4 | SkillBundleManager, AdvancedSelector, UI | 1200+ | ✅ Complete |
| 5 | Integration, Testing, Service | 1300+ | ✅ Complete |
| **Total** | | **6900+** | ✅ **Complete** |

---

## Next Steps

The ducKI Agent now has feature parity with the Hermes Agent:

1. **Deploy**: Roll out settings and credentials management
2. **Monitor**: Track provider usage, skill selection accuracy, context compression
3. **Optimize**: Tune thresholds based on your workload
4. **Extend**: Add custom skill bundles and providers as needed
5. **Iterate**: Refine based on usage metrics and user feedback

---

## References

- [Hermes Agent Repository](https://github.com/NousResearch/hermes-agent)
- Architecture decisions documented in commit messages
- Test patterns in `packages/agent/test/`
- Configuration examples in `apps/server/src/lib/`
- UI implementation in `apps/web/src/components/settings/`

---

**Document Version:** 1.0  
**Date:** 2026-07-29  
**Status:** Complete for Phase 5 Delivery
