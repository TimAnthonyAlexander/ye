import { classifyMidStreamError } from "../errors.ts";
import { sseDataLines } from "../sse.ts";
import type { ProviderError, ProviderEvent, ReasoningDetail, StopReason } from "../types.ts";

// DeepSeek's chat-completions SSE shape (OpenAI-compatible):
//   - `delta.reasoning_content` is streamed first (string deltas)
//   - then `delta.content` for the final visible answer
//   - both streams never appear in the same chunk
//   - tool calls arrive via `delta.tool_calls` (same as OpenAI/OpenRouter)
//   - `stream_options.include_usage: true` adds a final chunk with usage and
//     empty choices, before `data: [DONE]`
// finish_reason values: stop, length, tool_calls, content_filter, insufficient_system_resource

interface ToolCallAccumulator {
    id?: string;
    name?: string;
    args: string;
}

interface ChunkChoiceDelta {
    role?: string;
    content?: string;
    reasoning_content?: string;
    tool_calls?: ReadonlyArray<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
    }>;
}

interface ChunkChoice {
    index?: number;
    delta?: ChunkChoiceDelta;
    finish_reason?: string | null;
}

interface DeepSeekUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
}

interface ChunkPayload {
    choices?: ReadonlyArray<ChunkChoice>;
    usage?: DeepSeekUsage;
    error?: { message?: string; code?: string | number };
}

const buildUsageEvent = (u: DeepSeekUsage): ProviderEvent | null => {
    const totalIn = u.prompt_tokens ?? 0;
    const out = u.completion_tokens ?? 0;
    if (totalIn === 0 && out === 0) return null;
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    const billableIn = Math.max(0, totalIn - cached);
    return {
        type: "usage",
        usage: {
            inputTokens: billableIn,
            outputTokens: out,
            ...(cached > 0 ? { cacheReadTokens: cached } : {}),
        },
    };
};

const mapFinishReason = (raw: string | null | undefined): StopReason => {
    switch (raw) {
        case "stop":
            return "end_turn";
        case "tool_calls":
            return "tool_use";
        case "length":
            return "max_tokens";
        case "error":
        case "content_filter":
        case "insufficient_system_resource":
            return "error";
        default:
            return "end_turn";
    }
};

const safeParseJson = (raw: string): ChunkPayload | null => {
    try {
        return JSON.parse(raw) as ChunkPayload;
    } catch {
        return null;
    }
};

// Wrap an accumulated reasoning text into a single structured detail. DeepSeek
// streams plain text only — no per-block ids, no signatures, no encryption —
// so we synthesize one reasoning.text block with format "unknown". When the
// host turn round-trips through deepseek/adapt.ts the block is flattened back
// to `reasoning_content` on the wire.
const synthesizeDetail = (text: string): readonly ReasoningDetail[] =>
    text.length > 0 ? [{ type: "reasoning.text", text, format: "unknown", index: 0 }] : [];

interface NonStreamMessage {
    role?: string;
    content?: string | null;
    reasoning_content?: string;
    tool_calls?: ReadonlyArray<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
    }>;
}

interface NonStreamChoice {
    index?: number;
    message?: NonStreamMessage;
    finish_reason?: string | null;
}

interface NonStreamResponse {
    choices?: ReadonlyArray<NonStreamChoice>;
    usage?: DeepSeekUsage;
    error?: { message?: string };
}

export const formatDeepSeekError = (raw: string): string => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return "unknown DeepSeek error";
    try {
        const j = JSON.parse(trimmed) as { error?: { message?: string } };
        if (j.error?.message) return j.error.message;
    } catch {
        /* not JSON, return as-is */
    }
    return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
};

// Single-shot parse for the recovery layer's stream→batch fallback.
export async function* parseBatch(response: Response): AsyncGenerator<ProviderEvent> {
    let json: NonStreamResponse;
    try {
        json = (await response.json()) as NonStreamResponse;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield {
            type: "stop",
            reason: "error",
            error: classifyMidStreamError(`failed to parse non-streaming response: ${msg}`),
        };
        return;
    }

    if (json.error) {
        yield {
            type: "stop",
            reason: "error",
            error: classifyMidStreamError(json.error.message ?? "unknown DeepSeek error"),
        };
        return;
    }

    const choice = json.choices?.[0];
    const message = choice?.message ?? {};
    const stopReason: StopReason = mapFinishReason(choice?.finish_reason);

    if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
        yield { type: "reasoning.delta", text: message.reasoning_content };
        yield { type: "reasoning.complete", details: synthesizeDetail(message.reasoning_content) };
    }

    if (typeof message.content === "string" && message.content.length > 0) {
        yield { type: "text.delta", text: message.content };
    }

    if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
            if (!tc.id || !tc.function?.name) continue;
            const argText = tc.function.arguments ?? "";
            let args: unknown;
            try {
                args = JSON.parse(argText.length > 0 ? argText : "{}");
            } catch {
                args = { _raw: argText };
            }
            yield { type: "tool_call", id: tc.id, name: tc.function.name, args };
        }
    }

    if (json.usage) {
        const ev = buildUsageEvent(json.usage);
        if (ev) yield ev;
    }

    yield { type: "stop", reason: stopReason };
}

export async function* parseStream(response: Response): AsyncGenerator<ProviderEvent> {
    const toolCalls = new Map<number, ToolCallAccumulator>();
    let reasoningBuffer = "";
    let stopReason: StopReason = "end_turn";
    let errorPayload: ProviderError | undefined;
    let pendingUsage: DeepSeekUsage | undefined;

    for await (const data of sseDataLines(response)) {
        const chunk = safeParseJson(data);
        if (!chunk) continue;

        if (chunk.error) {
            stopReason = "error";
            errorPayload = classifyMidStreamError(chunk.error.message ?? "unknown DeepSeek error");
            break;
        }

        if (chunk.usage) pendingUsage = chunk.usage;

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};

        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            reasoningBuffer += delta.reasoning_content;
            yield { type: "reasoning.delta", text: delta.reasoning_content };
        }

        if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "text.delta", text: delta.content };
        }

        if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const acc = toolCalls.get(idx) ?? { args: "" };
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (typeof tc.function?.arguments === "string") {
                    acc.args += tc.function.arguments;
                }
                toolCalls.set(idx, acc);
            }
        }

        if (choice.finish_reason) {
            stopReason = mapFinishReason(choice.finish_reason);
        }
    }

    if (stopReason === "tool_use") {
        for (const acc of toolCalls.values()) {
            if (!acc.id || !acc.name) continue;
            let args: unknown;
            try {
                args = JSON.parse(acc.args.length > 0 ? acc.args : "{}");
            } catch {
                args = { _raw: acc.args };
            }
            yield { type: "tool_call", id: acc.id, name: acc.name, args };
        }
    }

    if (reasoningBuffer.length > 0) {
        yield { type: "reasoning.complete", details: synthesizeDetail(reasoningBuffer) };
    }

    if (pendingUsage) {
        const ev = buildUsageEvent(pendingUsage);
        if (ev) yield ev;
    }

    yield errorPayload !== undefined
        ? { type: "stop", reason: stopReason, error: errorPayload }
        : { type: "stop", reason: stopReason };
}
