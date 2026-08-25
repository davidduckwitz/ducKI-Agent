export function createProvider(config, context) {
  if (!context.createOpenAICompatibleProvider) {
    throw new Error("Host does not provide the OpenAI-compatible provider adapter");
  }
  return context.createOpenAICompatibleProvider({
    baseUrl: config.baseUrl || "https://api.nousresearch.com/v1",
    apiKey: config.apiKey,
    model: config.model || "nous-hermes-2-mixtral-8x7b-dpo",
  }, "nous");
}
