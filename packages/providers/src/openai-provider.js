import OpenAI from "openai";
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function normalizeBaseUrl(baseUrl) {
    const trimmed = baseUrl.trim().replace(/\/+$/g, "");
    if (!trimmed)
        return baseUrl;
    return trimmed
        .replace(/\/chat\/completions$/i, "")
        .replace(/\/responses$/i, "");
}
function shouldOmitAuthorizationHeader(apiKey) {
    const normalized = apiKey.trim().toLowerCase();
    if (!normalized)
        return true;
    if (["lm-studio", "not-needed", "none", "null", "undefined"].includes(normalized))
        return true;
    return false;
}
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
    maxRetries;
    baseRetryDelayMs;
    constructor(options) {
        const rawApiKey = options.apiKey ?? "";
        const normalizedApiKey = rawApiKey.replace(/^Bearer\s+/i, "").trim();
        const omitAuthorizationHeader = shouldOmitAuthorizationHeader(normalizedApiKey);
        const baseURL = normalizeBaseUrl(options.baseUrl);
        this.model = options.model;
        this.defaultOptions = options.defaultOptions ?? {};
        const customFetch = async (input, init) => {
            if (!omitAuthorizationHeader) {
                return fetch(input, init);
            }
            const headers = new Headers(init?.headers ?? {});
            headers.delete("Authorization");
            return fetch(input, { ...(init ?? {}), headers });
        };
        this.client = new OpenAI({
            apiKey: omitAuthorizationHeader ? "sk-no-auth-required" : normalizedApiKey,
            baseURL,
            fetch: customFetch,
        });
        this.maxRetries = toPositiveInt(process.env["OPENAI_RATE_LIMIT_RETRIES"], 2);
        this.baseRetryDelayMs = toPositiveInt(process.env["OPENAI_RATE_LIMIT_RETRY_BASE_MS"], 1200);
    }
    getStatusCode(error) {
        if (!error || typeof error !== "object")
            return undefined;
        const maybeError = error;
        return typeof maybeError.status === "number" ? maybeError.status : undefined;
    }
    getRetryAfterMs(error) {
        if (!error || typeof error !== "object")
            return undefined;
        const maybeError = error;
        const headers = maybeError.headers;
        if (!headers)
            return undefined;
        if (typeof headers.get === "function") {
            const raw = headers.get("retry-after");
            if (!raw)
                return undefined;
            const seconds = Number.parseFloat(raw);
            if (Number.isFinite(seconds) && seconds > 0)
                return Math.round(seconds * 1000);
            return undefined;
        }
        if (typeof headers === "object" && headers !== null) {
            const raw = headers["retry-after"];
            if (typeof raw === "string") {
                const seconds = Number.parseFloat(raw);
                if (Number.isFinite(seconds) && seconds > 0)
                    return Math.round(seconds * 1000);
            }
        }
        return undefined;
    }
    isRateLimitError(error) {
        return this.getStatusCode(error) === 429;
    }
    createRetryDelayMs(attempt, error) {
        const retryAfterMs = this.getRetryAfterMs(error);
        if (retryAfterMs && retryAfterMs > 0)
            return retryAfterMs;
        const expDelay = this.baseRetryDelayMs * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * 250);
        return expDelay + jitter;
    }
    async withRateLimitRetry(fn) {
        let attempt = 0;
        let lastError;
        while (attempt <= this.maxRetries) {
            try {
                return await fn();
            }
            catch (error) {
                lastError = error;
                if (!this.isRateLimitError(error) || attempt >= this.maxRetries) {
                    break;
                }
                const delayMs = this.createRetryDelayMs(attempt + 1, error);
                await sleep(delayMs);
                attempt++;
            }
        }
        if (this.isRateLimitError(lastError)) {
            throw new Error("429 Provider returned error after retries (rate limited)");
        }
        throw lastError;
    }
    async generate(messages, options) {
        const merged = { ...this.defaultOptions, ...options };
        const completion = await this.withRateLimitRetry(() => this.client.chat.completions.create({
            model: this.model,
            messages: toOpenAIMessages(messages),
            temperature: merged.temperature,
            top_p: merged.topP,
            max_tokens: merged.maxTokens,
            stream: false,
        }));
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
        const stream = await this.withRateLimitRetry(() => this.client.chat.completions.create({
            model: this.model,
            messages: toOpenAIMessages(messages),
            temperature: merged.temperature,
            top_p: merged.topP,
            max_tokens: merged.maxTokens,
            stream: true,
        }));
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