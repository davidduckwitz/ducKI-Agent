# LLM provider plugins

An enabled, Node-trusted plugin can add one or more providers to the main LLM provider list.
Each provider module must implement the normal `LLMProvider` interface and `listModels()`.

```json
{
  "name": "acme-provider",
  "version": "1.0.0",
  "description": "Acme LLM integration",
  "trust": "node",
  "provides": {
    "llmProviders": [{
      "id": "acme-ai",
      "name": "Acme AI",
      "description": "Acme hosted models",
      "icon": "🔌",
      "module": "provider.js",
      "modelSetting": "ACME_MODEL",
      "baseUrlSetting": "ACME_BASE_URL",
      "apiKeySetting": "ACME_API_KEY",
      "defaultModel": "acme-small",
      "defaultBaseUrl": "https://api.acme.example/v1"
    }]
  }
}
```

The module exports `createProvider(config, context)`. `config` contains the current `model`,
`baseUrl`, and `apiKey` values from Settings. `context` is the same guarded Node plugin context
used by module tools.

```js
export function createProvider(config, context) {
  return context.createOpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model
  }, "acme-ai");
}
```

Provider ids must be unique and cannot replace built-in provider ids. Plugin providers are loaded
and removed with the existing plugin enable/disable and hot-reload lifecycle.
