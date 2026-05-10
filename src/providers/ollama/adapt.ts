import type { Message, ProviderInput, ToolDefinition } from "../types.ts";

interface OllamaToolCall {
    readonly type?: "function";
    readonly function: {
        readonly name: string;
        readonly arguments: unknown;
    };
}

interface OllamaMessage {
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly content: string;
    readonly tool_calls?: readonly OllamaToolCall[];
    // Ollama replies use `tool_name` (not `tool_call_id`) to associate a tool
    // result with the call. Order is preserved by the assistant tool_calls list.
    readonly tool_name?: string;
    readonly thinking?: string;
}

interface OllamaTool {
    readonly type: "function";
    readonly function: {
        readonly name: string;
        readonly description: string;
        readonly parameters: object;
    };
}

interface OllamaOptions {
    temperature?: number;
    num_predict?: number;
    num_ctx?: number;
}

export interface OllamaRequestBody {
    readonly model: string;
    readonly messages: readonly OllamaMessage[];
    readonly stream: boolean;
    readonly tools?: readonly OllamaTool[];
    readonly think?: boolean;
    readonly options?: OllamaOptions;
    readonly keep_alive?: string | number;
    readonly format?: string | object;
}

const safeParseJson = (raw: string): unknown => {
    if (raw.length === 0) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
};

const toOllamaTool = (t: ToolDefinition): OllamaTool => ({
    type: "function",
    function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    },
});

const convertMessage = (msg: Message): OllamaMessage | null => {
    if (msg.role === "system" || msg.role === "user") {
        return { role: msg.role, content: typeof msg.content === "string" ? msg.content : "" };
    }
    if (msg.role === "assistant") {
        const text = typeof msg.content === "string" ? msg.content : "";
        const calls = msg.tool_calls ?? [];
        if (calls.length === 0) return { role: "assistant", content: text };
        // Ollama parses `arguments` as a JSON object on the wire (unlike the
        // OpenAI string form). Reverse the stringify we did when capturing.
        const tool_calls: OllamaToolCall[] = calls.map((tc) => ({
            type: "function",
            function: { name: tc.function.name, arguments: safeParseJson(tc.function.arguments) },
        }));
        return { role: "assistant", content: text, tool_calls };
    }
    if (msg.role === "tool") {
        return {
            role: "tool",
            content: typeof msg.content === "string" ? msg.content : "",
            // Pipeline carries the function name in `name`. Fall back to "" so
            // Ollama parses something rather than 400ing if the field is absent.
            tool_name: msg.name ?? "",
        };
    }
    return null;
};

export const buildRequestBody = (input: ProviderInput): OllamaRequestBody => {
    const messages: OllamaMessage[] = [];
    for (const m of input.messages) {
        const next = convertMessage(m);
        if (next) messages.push(next);
    }

    const opts: OllamaOptions = {};
    if (input.temperature !== undefined) opts.temperature = input.temperature;
    if (input.maxTokens !== undefined) opts.num_predict = input.maxTokens;

    const providerOpts = input.providerOptions ?? {};
    const numCtx = providerOpts["numCtx"];
    if (typeof numCtx === "number" && Number.isInteger(numCtx) && numCtx > 0) {
        opts.num_ctx = numCtx;
    }

    const body: {
        model: string;
        messages: OllamaMessage[];
        stream: boolean;
        tools?: OllamaTool[];
        think?: boolean;
        options?: OllamaOptions;
        keep_alive?: string | number;
        format?: string | object;
    } = {
        model: input.model,
        messages,
        stream: input.stream !== false,
    };

    if (input.tools && input.tools.length > 0) {
        body.tools = input.tools.map(toOllamaTool);
    }

    // Reasoning ("thinking") is opt-in. Caller sets providerOptions.think=true
    // for thinking-capable models (qwen3, deepseek-r1, etc.). When unset or
    // false we leave it off so non-thinking models don't 400.
    if (providerOpts["think"] === true) {
        body.think = true;
    }

    if (Object.keys(opts).length > 0) {
        body.options = opts;
    }

    const keepAlive = providerOpts["keepAlive"];
    if (typeof keepAlive === "string" || typeof keepAlive === "number") {
        body.keep_alive = keepAlive;
    }

    const format = providerOpts["format"];
    if (typeof format === "string" || (typeof format === "object" && format !== null)) {
        body.format = format as string | object;
    }

    return body;
};
