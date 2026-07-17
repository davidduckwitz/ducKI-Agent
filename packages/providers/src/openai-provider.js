import OpenAI from "openai";
function toOpenAIMessages(messages) {
    return messages.map((m) => {
        if (m.role === "tool") {
            return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "unknown" };
        }
        if (m.role === "assistant") {
            return { role: "assistant", content: m.content };
        }
        if (m.role === "system") {
            return { role: "system", content: m.content };
        }
        return { role: "user", content: m.content };
    });
}
export class OpenAIProvider {
    name = "openai";
    model;
    client;
    defaultOptions;
    constructor(options) {
        this.model = options.model;
        this.defaultOptions = options.defaultOptions ?? {};
        this.client = new OpenAI({
            apiKey: options.apiKey ?? process.env["OPENAI_API_KEY"] ?? "",
            baseURL: options.baseUrl,
        });
    }
    async generate(messages, options) {
        const merged = { ...this.defaultOptions, ...options };
        const completion = await this.client.chat.completions.create({
            model: this.model,
            messages: toOpenAIMessages(messages),
            temperature: merged.temperature,
            top_p: merged.topP,
            max_tokens: merged.maxTokens,
            stream: false,
        });
        const choice = completion.choices[0];
        if (!choice)
            throw new Error("No completion choice returned");
        return {
            content: choice.message.content ?? "",
            usage: {
                promptTokens: completion.usage?.prompt_tokens ?? 0,
                completionTokens: completion.usage?.completion_tokens ?? 0,
                totalTokens: completion.usage?.total_tokens ?? 0,
            },
            model: completion.model,
            finishReason: choice.finish_reason ?? undefined,
        };
    }
    async generateStream(messages, options, onChunk) {
        const merged = { ...this.defaultOptions, ...options };
        const stream = await this.client.chat.completions.create({
            model: this.model,
            messages: toOpenAIMessages(messages),
            temperature: merged.temperature,
            top_p: merged.topP,
            max_tokens: merged.maxTokens,
            stream: true,
        });
        let fullContent = "";
        let promptTokens = 0;
        let completionTokens = 0;
        let finalModel = this.model;
        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content ?? "";
            if (delta) {
                fullContent += delta;
                onChunk?.(delta);
            }
            if (chunk.usage) {
                promptTokens = chunk.usage.prompt_tokens ?? 0;
                completionTokens = chunk.usage.completion_tokens ?? 0;
            }
            finalModel = chunk.model ?? finalModel;
        }
        return {
            content: fullContent,
            usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
            model: finalModel,
        };
    }
    supportsStreaming() {
        return true;
    }
    async isAvailable() {
        try {
            await this.client.models.list();
            return true;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=openai-provider.js.map