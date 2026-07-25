# Image Processing in DucKI Agent

## Overview

The DucKI Agent now supports image processing and analysis through structured message content. This enables both user-provided images and automatic browser screenshots to be analyzed by vision-capable LLM models.

## Features

### 1. User-Provided Images
Users can upload images for the agent to analyze:
- Supported formats: PNG, JPEG, GIF, WebP
- Images are converted to Base64 and included in messages
- Agent analyzes visual content and provides insights

### 2. Automatic Browser Screenshots
When the agent uses the browser tool:
- Screenshots are automatically captured after `screenshot` action
- Converted to Base64 data URIs
- Attached as image content to next LLM message
- Vision models analyze screenshots for UI/UX feedback

### 3. Multi-Provider Support
Vision support works across all LLM providers:
- **OpenAI**: Full vision API support (GPT-4 Vision)
- **OpenRouter**: Vision models from multiple providers
- **Ollama**: Local vision models (llava, etc.)
- **LM Studio**: Local inference with vision support

## Message Format

### LLMContent Type
Messages now support structured content with mixed text and images:

```typescript
type LLMContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
  | { type: "image_data"; image_data: { url: string; mime_type: string } };

interface LLMMessage {
  role: MessageRole;
  content: string | LLMContent[];  // Now supports arrays
  toolCallId?: string;
  toolCalls?: ToolCall[];
  metadata?: string | Record<string, unknown>;
}
```

### Content Array Example
```typescript
const messageWithImage: LLMMessage = {
  role: "user",
  content: [
    { type: "text", text: "What do you see in this screenshot?" },
    { type: "image_data", image_data: { 
      url: "data:image/png;base64,...",
      mime_type: "image/png"
    }}
  ]
};
```

## Architecture

### Message Flow
```
User Input / Browser Screenshot
    ↓
Convert to Base64 data URI
    ↓
Wrap in LLMContent array
    ↓
Add to ConversationManager
    ↓
buildConversationWindow() includes image
    ↓
buildMessages() constructs full array
    ↓
provider.generate(messages)
    ↓
toOpenAIMessages() converts to provider format
    ↓
Vision API processes image + text
    ↓
Agent receives analysis
```

### Key Components

**packages/shared/src/index.ts**
- `LLMContent` type definition
- `LLMMessage` interface with union content type

**packages/providers/src/openai-provider.ts**
- `convertLLMContentToOpenAI()` - Transforms content arrays
- `toOpenAIMessages()` - Handles both string and array content
- Automatic provider inheritance (OpenRouter, Ollama, LM Studio)

**packages/agent/src/agent.ts**
- `handleScreenshotCapture()` - Auto-captures browser screenshots
- `compressImageBuffer()` - Size management for large images
- System prompt includes vision instructions

**packages/agent/src/conversation/conversation.ts**
- Stores content arrays as JSON in database
- Full backward compatibility with string content

## Usage

### Automatic Screenshot Analysis
```typescript
// When agent uses browser tool with screenshot action:
const browserTool = await agent.run({
  input: "Take a screenshot and analyze the page layout",
  // ... options
});

// Agent automatically:
// 1. Executes browser screenshot
// 2. Captures PNG buffer
// 3. Converts to Base64
// 4. Creates image message
// 5. Includes in next LLM call
// 6. Vision model analyzes and responds
```

### Manual Image Upload
```typescript
const imageMessage: LLMMessage = {
  role: "user",
  content: [
    { type: "text", text: "Please describe this design mockup" },
    { type: "image_data", image_data: { 
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
      mime_type: "image/png"
    }}
  ]
};

await conversation.addMessage(imageMessage);
```

## Performance Considerations

### Image Size
- Large images consume many tokens in vision APIs
- Recommended max: 512px for low detail, 1024px for high detail
- Token cost: ~170-300 tokens per image depending on resolution

### Compression Strategy
```typescript
// Low detail: Fast processing, fewer tokens
{ detail: "low" }     // ~85 tokens

// High detail: More accurate, more tokens  
{ detail: "high" }    // ~300 tokens

// Auto: Provider decides
{ detail: "auto" }    // ~170 tokens
```

### Future Optimization
With `sharp` library (optional):
```bash
npm install sharp  # Optional for advanced image processing
```

Then use for:
- Resizing to optimal dimensions
- Format conversion (PNG → WebP)
- Quality compression (80% JPEG quality)

## Model Support

### Recommended Vision Models
- **OpenAI**: gpt-4-vision, gpt-4-turbo-with-vision
- **OpenRouter**: claude-3-vision, gpt-4-vision, llava-13b
- **Ollama**: llava:latest, bakllava
- **LM Studio**: Local vision models

### Fallback Behavior
Models without vision support:
- Text description provided instead of image
- No errors - graceful degradation
- Agent continues normally

## Backward Compatibility

All existing code continues to work:
```typescript
// Old style - still works
const message: LLMMessage = {
  role: "user",
  content: "This is just text"
};

// New style - also works
const messageWithImage: LLMMessage = {
  role: "user", 
  content: [
    { type: "text", text: "Text with image" },
    { type: "image_data", ... }
  ]
};
```

## Testing

### Unit Tests
```bash
npm run test -- packages/agent/src/agent.test.ts
```

Tests include:
- Image buffer to Base64 conversion
- LLMContent array handling
- Provider message transformation
- Screenshot capture flow

### Integration Tests
```bash
npm run test:integration -- image-processing
```

Tests include:
- Full screenshot → analysis flow
- Multiple images in single message
- Large image handling
- Provider API compatibility

## Troubleshooting

### Images Not Showing in Agent
1. Check `supportsImageInput` capability is true
2. Verify provider model supports vision
3. Check image buffer conversion (should be PNG or JPEG)

### Large Image Warnings
```
Warning: Large image buffer { size: 250000, max: 100000 }
```
- Consider adding `sharp` library for resizing
- Or implement client-side compression
- Future: Automatic resizing in `compressImageBuffer()`

### Provider Format Errors
If using custom provider:
- Implement `convertLLMContentToOpenAI()` equivalent
- Transform LLMContent[] to provider-specific format
- Map `image_data` to provider's image input format

## Future Enhancements

1. **Image Processing Library** - Add `sharp` for resizing/compression
2. **OCR Integration** - Extract text from screenshots
3. **Image Diff Detection** - Compare sequential screenshots
4. **Visual Region Focusing** - Crop to specific areas
5. **Image Analytics** - Size/resolution optimization
6. **Caching** - Cache base64 data for repeated images

## References

- [OpenAI Vision API](https://platform.openai.com/docs/guides/vision)
- [Claude Vision](https://docs.anthropic.com/claude/reference/vision)
- [Ollama Vision Models](https://ollama.ai/library?search=vision)
- [LLM Vision Capabilities Comparison](https://github.com/anthropics/anthropic-sdk-js#vision)
