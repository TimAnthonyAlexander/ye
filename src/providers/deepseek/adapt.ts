import type { Message, ProviderInput, ReasoningDetail, ToolDefinition } from "../types.ts";

interface DeepSeekToolDef {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: object;
    };
}

interface DeepSeekThinking {
    type: "enabled" | "disabled";
}

interface DeepSeekStreamOptions {
    include_usage: boolean;
}

// Wire-shape of an assistant message. Optional `reasoning_content` is the
// DeepSeek-native field; it must round-trip inside an active tool-call loop
// (else HTTP 400) and must be cleared between user turns (else quality
// degrades and bandwidth is wasted).
interface WireMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: Message["tool_calls"];
    tool_call_id?: string;
    name?: string;
    reasoning_content?: string;
}

interface DeepSeekRequestBody {
    model: string;
    messages: readonly WireMessage[];
    stream: boolean;
    stream_options?: DeepSeekStreamOptions;
    tools?: DeepSeekToolDef[];
    tool_choice?: "auto" | "none";
    parallel_tool_calls?: boolean;
    temperature?: number;
    max_tokens?: number;
    thinking?: DeepSeekThinking;
    reasoning_effort?: "high" | "max";
}

const toDeepSeekTool = (t: ToolDefinition): DeepSeekToolDef => ({
    type: "function",
    function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    },
});

// Concatenate every reasoning.text block into a single string, in emission
// order. Encrypted / summary detail variants don't apply to DeepSeek — only
// reasoning.text round-trips through their native `reasoning_content`.
const flattenReasoningText = (details: readonly ReasoningDetail[]): string => {
    let out = "";
    for (const d of details) {
        if (d.type === "reasoning.text") out += d.text;
    }
    return out;
};

// Walk messages and emit the wire-shape array. Include `reasoning_content` on
// every assistant message that has it, regardless of whether the message
// belongs to a closed prior turn or the current tool-call loop. Per DeepSeek's
// thinking-mode docs, two rules apply:
//   * During an active tool-call loop, reasoning_content MUST be passed back
//     on every assistant message — else the API returns 400.
//   * On closed prior turns it is ignored by the model. Including it is
//     harmless.
// We used to strip it for closed prior turns ("bandwidth optimization") but
// that mutates the bytes of prior assistant messages between user turns,
// which busts DeepSeek's prefix cache for everything after the divergence
// point. Always-keep makes the prefix byte-stable across user turns — same
// cache entry, same hit. The wasted bandwidth is cache-read tokens (10× cheaper
// than fresh input on V4-pro), so this is strictly better.
const toWireMessages = (messages: readonly Message[]): readonly WireMessage[] => {
    return messages.map((m): WireMessage => {
        const base: WireMessage = {
            role: m.role,
            content: m.content,
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            ...(m.name ? { name: m.name } : {}),
        };
        if (m.role !== "assistant") return base;
        if (!m.reasoning_details || m.reasoning_details.length === 0) return base;
        const text = flattenReasoningText(m.reasoning_details);
        if (text.length === 0) return base;
        return { ...base, reasoning_content: text };
    });
};

// Map a Ye effort hint (low/medium/high/max) to DeepSeek's accepted values.
// Per docs: low/medium → high, xhigh → max, low/null when thinking disabled.
const resolveEffort = (raw: unknown): "high" | "max" | null => {
    if (raw === false || raw === null) return null;
    if (typeof raw === "object" && raw !== null && "effort" in raw) {
        const e = (raw as { effort?: string }).effort;
        if (e === "max" || e === "xhigh") return "max";
        return "high";
    }
    return "high";
};

export const buildRequestBody = (input: ProviderInput): DeepSeekRequestBody => {
    const opts = input.providerOptions ?? {};
    const effort = resolveEffort(opts["reasoning"]);

    const body: DeepSeekRequestBody = {
        model: input.model,
        messages: toWireMessages(input.messages),
        stream: input.stream !== false,
    };

    if (body.stream) {
        body.stream_options = { include_usage: true };
    }

    if (input.tools && input.tools.length > 0) {
        body.tools = input.tools.map(toDeepSeekTool);
        body.parallel_tool_calls = false;
    }

    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;

    if (effort === null) {
        body.thinking = { type: "disabled" };
    } else {
        body.thinking = { type: "enabled" };
        body.reasoning_effort = effort;
    }

    return body;
};

// Exposed for unit tests.
export const _internal = { toWireMessages, flattenReasoningText };
