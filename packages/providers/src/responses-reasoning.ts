import type OpenAI from "openai";
import type { Response as ModelResponse, ResponseCreateParamsNonStreaming, ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { INCOMPLETE_STREAM_FINISH_REASON, type GenerateOptions, type LLMMessage, type LLMResponse } from "@ducki/shared";
import { isAbortError } from "./errors.js";
import { estimateUsage } from "./token-estimate.js";
import { resolveReasoningEffort } from "./reasoning.js";
import { toOpenAIMessages } from "./openai-provider.js";

/** LM Studio exposes effort through /responses, not reliably through /chat/completions. */
export async function generateReasoningResponse(
  client: OpenAI,
  model: string,
  messages: LLMMessage[],
  options: GenerateOptions,
  stream: boolean,
  onChunk?: (chunk: string) => void,
): Promise<LLMResponse> {
  const input: Record<string, unknown>[] = [];
  const callIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId && callIds.has(message.toolCallId)) {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: typeof message.content === "string" ? message.content : JSON.stringify(message.content) });
      continue;
    }
    const content = typeof message.content === "string" ? message.content : message.content.map((part) =>
      part.type === "text" ? { type: "input_text", text: part.text } : {
        type: "input_image", image_url: part.type === "image_url" ? part.image_url.url : part.image_data.url,
      });
    if (content.length > 0) input.push({ role: message.role === "tool" ? "user" : message.role, content });
    for (const call of message.toolCalls ?? []) {
      callIds.add(call.id);
      input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  const effort = resolveReasoningEffort(options);
  const body = {
    model, input, store: false,
    reasoning: { effort: effort === "off" ? "none" : effort },
    max_output_tokens: options.maxTokens,
    ...(options.tools?.length ? {
      tools: options.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
      tool_choice: "auto",
    } : {}),
  };
  const convert = (response: ModelResponse): LLMResponse => {
    if (response.error) throw new Error(response.error.message);
    const content = response.output.filter((item) => item.type === "message")
      .flatMap((item) => item.content).map((part) => part.type === "output_text" ? part.text : "").join("");
    const calls = response.output.filter((item) => item.type === "function_call").map((item) => ({
      id: item.call_id, type: "function" as const, function: { name: item.name, arguments: item.arguments },
    }));
    return {
      content, model: response.model,
      toolCalls: calls.length ? calls : undefined,
      finishReason: response.status === "incomplete" ? "length" : calls.length ? "tool_calls" : "stop",
      usage: response.usage ? {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.total_tokens,
      } : { ...estimateUsage(toOpenAIMessages(messages), content), estimated: true },
    };
  };
  // The installed SDK's effort enum predates none/xhigh; preserve the wire values.
  if (!stream) return convert(await client.responses.create(body as unknown as ResponseCreateParamsNonStreaming, { signal: options.signal }));
  const events = await client.responses.create({ ...body, stream: true } as unknown as ResponseCreateParamsStreaming, { signal: options.signal });
  let content = "";
  try {
    for await (const event of events) {
      if (event.type === "response.output_text.delta") {
        content += event.delta;
        onChunk?.(event.delta);
      } else if (event.type === "response.completed" || event.type === "response.incomplete") {
        return convert(event.response);
      } else if (event.type === "response.failed") {
        throw new Error(event.response.error?.message ?? "LM Studio response failed");
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }
  } catch (error) {
    if (isAbortError(error) || !content) throw error;
  }
  if (!content) throw new Error("LM Studio response stream ended without a completed response");
  return { content, model, finishReason: INCOMPLETE_STREAM_FINISH_REASON, usage: { ...estimateUsage(toOpenAIMessages(messages), content), estimated: true } };
}
