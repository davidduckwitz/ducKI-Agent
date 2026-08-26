const CODING_MARKERS = [
  'codingagent',
  'disciplined autonomous coding agent',
  'read-before-edit',
  'coding discipline',
];

function normalizeBaseUrl(value) {
  let result = String(value || '').trim();
  while (result.endsWith('/')) result = result.slice(0, -1);
  return result;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part && part.type === 'text' ? String(part.text || '') : '').join('\n');
}

function detectAgentType(messages) {
  const systemText = (messages || [])
    .filter((message) => message && message.role === 'system')
    .map((message) => contentText(message.content))
    .join('\n')
    .toLowerCase();
  return CODING_MARKERS.some((marker) => systemText.includes(marker)) ? 'coding' : 'ai';
}

function toOpenAIContent(content) {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part && part.type === 'image_data') {
      return { type: 'image_url', image_url: { url: part.image_data.url } };
    }
    return part;
  });
}

function toOpenAIMessages(messages) {
  return (messages || []).map((message) => {
    const content = toOpenAIContent(message.content);
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: contentText(content) };
    }
    const result = { role: message.role, content };
    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      result.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.function.name, arguments: call.function.arguments },
      }));
    }
    return result;
  });
}

function toOpenAITools(tools) {
  return (tools || []).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters || { type: 'object', properties: {} } },
  }));
}

function normalizeUsage(usage, messages, content) {
  const input = Number(usage?.prompt_tokens || usage?.input_tokens || 0);
  const output = Number(usage?.completion_tokens || usage?.output_tokens || 0);
  if (input > 0 || output > 0) {
    return { promptTokens: input, completionTokens: output, totalTokens: Number(usage?.total_tokens || input + output), estimated: false };
  }
  const promptTokens = Math.max(1, Math.ceil((messages || []).map((message) => contentText(message.content)).join('\n').length / 4));
  const completionTokens = Math.max(0, Math.ceil(String(content || '').length / 4));
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true };
}

function requestHeaders(token) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const value = String(token || '').trim().replace(/^Bearer\s+/i, '');
  if (value) headers.Authorization = 'Bearer ' + value;
  return headers;
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() || 'laravel-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function responseError(response, body) {
  const error = new Error('Laravel LLM request failed (' + response.status + '): ' + String(body || response.statusText || 'unknown error'));
  error.status = response.status;
  return error;
}

function createProvider(config, context = {}) {
  const baseUrl = normalizeBaseUrl(config.baseUrl || 'https://ducki.cloud/api/llm/v1');
  const apiKey = config.apiKey;
  const model = config.model || 'auto';
  const request = context.fetch || globalThis.fetch;
  const authUrl = normalizeBaseUrl(config.authUrl || baseUrl.replace(/\/api\/llm\/v1$/, '/api/token'));
  let cachedToken = '';
  let tokenExpiresAt = 0;

  async function getAccessToken(force = false) {
    const configuredKey = String(apiKey || '').trim();
    if (!configuredKey) throw new Error('Laravel LLM API key is not configured');
    if (!force && cachedToken && tokenExpiresAt > Date.now()) return cachedToken;
    const response = await request(authUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: configuredKey }),
    });
    if (!response.ok) throw responseError(response, await response.text().catch(() => ''));
    const payload = await response.json();
    const token = String(payload.access_token || '').trim();
    if (!token) throw new Error('Laravel API token endpoint returned no access_token');
    cachedToken = token;
    // Wave API-key JWTs are short-lived; refresh conservatively before their expiry.
    tokenExpiresAt = Date.now() + 45 * 1000;
    return cachedToken;
  }

  async function authenticatedRequest(url, init = {}, retry = true) {
    const token = await getAccessToken();
    const response = await request(url, { ...init, headers: { ...(init.headers || {}), ...requestHeaders(token) } });
    if (response.status === 401 && retry) {
      cachedToken = '';
      tokenExpiresAt = 0;
      return authenticatedRequest(url, init, false);
    }
    return response;
  }

  async function send(messages, options, stream) {
    const body = {
      model,
      messages: toOpenAIMessages(messages),
      stream,
      agent_type: detectAgentType(messages),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options?.tools?.length ? { tools: toOpenAITools(options.tools), tool_choice: 'auto' } : {}),
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
    const headers = { 'X-Request-Id': requestId() };
    const response = await authenticatedRequest(baseUrl + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: options?.signal });
    if (!response.ok) throw responseError(response, await response.text().catch(() => ''));
    return response;
  }

  return {
    name: 'laravel',
    model,
    supportsStreaming: () => true,
    supportsNativeTools: () => true,

    async generate(messages, options = {}) {
      const payload = await (await send(messages, options, false)).json();
      const choice = payload.choices?.[0];
      if (!choice) throw new Error('Laravel LLM returned no completion choice');
      const toolCalls = (choice.message?.tool_calls || []).filter((call) => call.function?.name).map((call, index) => ({
        id: call.id || 'call_' + index,
        type: 'function',
        function: { name: call.function.name, arguments: call.function.arguments || '{}' },
      }));
      return {
        content: choice.message?.content || '',
        toolCalls: toolCalls.length ? toolCalls : undefined,
        usage: normalizeUsage(payload.usage, messages, choice.message?.content),
        model: payload.model || model,
        finishReason: choice.finish_reason || undefined,
      };
    },

    async generateStream(messages, options = {}, onChunk) {
      const response = await send(messages, options, true);
      if (!response.body) throw new Error('Laravel LLM returned an empty stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let usage;
      let finalModel = model;
      let finishReason;
      const toolCalls = [];
      const consume = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const raw = trimmed.slice(5).trim();
        if (!raw || raw === '[DONE]') return;
        let chunk;
        try { chunk = JSON.parse(raw); } catch { return; }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.model) finalModel = chunk.model;
        const choice = chunk.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        if (delta.content) { content += delta.content; onChunk?.(delta.content); }
        for (const call of delta.tool_calls || []) {
          const index = call.index || 0;
          const current = toolCalls[index] || { id: 'call_' + index, name: '', arguments: '' };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name = call.function.name;
          if (call.function?.arguments) current.arguments += call.function.arguments;
          toolCalls[index] = current;
        }
      };
      while (true) {
        const next = await reader.read();
        buffer += decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.forEach(consume);
        if (next.done) break;
      }
      if (buffer) consume(buffer);
      const normalizedToolCalls = toolCalls.filter((call) => call?.name).map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
      }));
      return { content, toolCalls: normalizedToolCalls.length ? normalizedToolCalls : undefined, usage: normalizeUsage(usage, messages, content), model: finalModel, finishReason };
    },

    async isAvailable() {
      try {
        const response = await authenticatedRequest(baseUrl + '/models', { method: 'GET' });
        return response.ok;
      } catch {
        return false;
      }
    },

    async listModels() {
      const response = await authenticatedRequest(baseUrl + '/models', { method: 'GET' });
      if (!response.ok) throw responseError(response, await response.text().catch(() => ''));
      const payload = await response.json();
      const entries = Array.isArray(payload.data) ? payload.data : (Array.isArray(payload.data?.models) ? payload.data.models : []);
      return entries.map((entry) => ({ id: String(entry.id || entry.slug || ''), name: String(entry.name || entry.id || entry.slug || '') })).filter((entry) => entry.id);
    },
  };
}

export { createProvider };
