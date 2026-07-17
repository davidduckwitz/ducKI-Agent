export class Reflection {
    provider;
    logger;
    constructor(provider, logger) {
        this.provider = provider;
        this.logger = logger;
    }
    async evaluate(originalRequest, agentResponse, context) {
        const messages = [
            {
                role: "system",
                content: `You are a quality evaluation assistant. Evaluate the agent's response and return JSON:
{
  "quality": "poor|adequate|good|excellent",
  "issues": ["list of issues"],
  "suggestions": ["list of improvements"],
  "shouldRetry": boolean,
  "improvedResponse": "optional improved version"
}`,
            },
            {
                role: "user",
                content: `Evaluate this response:

Original request: ${originalRequest}
${context ? `Context: ${context}` : ""}

Agent response: ${agentResponse}

Return JSON evaluation only.`,
            },
        ];
        try {
            const response = await this.provider.generate(messages, {
                temperature: 0.2,
                maxTokens: 1000,
            });
            const result = JSON.parse(response.content);
            this.logger.debug("Reflection complete", { quality: result.quality });
            return result;
        }
        catch {
            return {
                quality: "adequate",
                issues: [],
                suggestions: [],
                shouldRetry: false,
            };
        }
    }
}
//# sourceMappingURL=reflection.js.map