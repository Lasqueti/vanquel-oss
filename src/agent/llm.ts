// src/agent/llm.ts
// The model, behind the OpenAI-compatible Chat Completions API with tool
// calls. That one shape covers OpenAI and most hosted or local providers that
// copy it (set LLM_BASE_URL). No SDK: one fetch.

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export interface ToolSchema {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmReply {
    content: string | null;
    toolCalls: ToolCall[];
}

export interface Llm {
    chat(messages: ChatMessage[], options?: { tools?: ToolSchema[]; json?: boolean; maxTokens?: number }): Promise<LlmReply>;
}

export interface LlmConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}

export function createLlm(config: LlmConfig): Llm {
    const fetchImpl = config.fetchImpl ?? fetch;
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    return {
        async chat(messages, options = {}) {
            const body: Record<string, unknown> = { model: config.model, messages };
            if (options.tools?.length) body.tools = options.tools;
            if (options.json) body.response_format = { type: 'json_object' };
            if (options.maxTokens) body.max_completion_tokens = options.maxTokens;
            const response = await fetchImpl(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(config.timeoutMs ?? 90_000),
            });
            if (!response.ok) throw new Error(`model API answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
            const data = (await response.json()) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }> };
            const message = data.choices?.[0]?.message;
            return { content: message?.content ?? null, toolCalls: message?.tool_calls ?? [] };
        },
    };
}
