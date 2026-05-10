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

// Find the index of the last user message in the array. Returns -1 if there
// is none (shouldn't happen for a real request).
const lastUserIndex = (messages: readonly Message[]): number => {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") return i;
    }
    return -1;
};

// Walk messages and emit the wire-shape array per DeepSeek's reasoning-state
// rules:
//   * assistant messages BEFORE the last user message belong to closed prior
//     turns → omit reasoning_content (official guidance: drop it, the API
//     ignores it and concatenated CoTs degrade quality)
//   * assistant messages AT-OR-AFTER the last user message belong to the
//     current user turn's tool-call sub-loop → include reasoning_content if we
//     have it (required, else HTTP 400 from V4 Pro consistency check)
const toWireMessages = (messages: readonly Message[]): readonly WireMessage[] => {
    const userIdx = lastUserIndex(messages);
    return messages.map((m, i): WireMessage => {
        const base: WireMessage = {
            role: m.role,
            content: m.content,
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            ...(m.name ? { name: m.name } : {}),
        };
        if (m.role !== "assistant") return base;
        if (i < userIdx) return base; // closed prior turn — strip reasoning
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

// Exposed for unit tests — verifies the tool-loop window rule without going
// through the full body builder.
export const _internal = { toWireMessages, flattenReasoningText, lastUserIndex };
