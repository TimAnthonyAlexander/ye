import { classifyMidStreamError } from "../errors.ts";
import { sseDataLines } from "../sse.ts";
import type { ProviderError, ProviderEvent, StopReason } from "../types.ts";

interface ToolCallAccumulator {
    id?: string;
    name?: string;
    args: string;
}

interface ReasoningDetail {
    type?: string;
    text?: string;
    summary?: string;
    format?: string;
    id?: string;
}

interface ChunkChoiceDelta {
    role?: string;
    content?: string;
    reasoning?: string;
    reasoning_content?: string;
    reasoning_details?: ReadonlyArray<ReasoningDetail>;
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

interface OpenRouterErrorPayload {
    message?: string;
    code?: number | string;
    type?: string;
    metadata?: {
        raw?: string;
        provider_name?: string;
        reasons?: ReadonlyArray<string>;
        flagged_input?: string;
    };
}

interface OpenRouterUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    cached_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
        cache_write_tokens?: number;
    };
}

const buildOpenRouterUsageEvent = (u: OpenRouterUsage): ProviderEvent | null => {
    const totalIn = u.prompt_tokens ?? 0;
    const out = u.completion_tokens ?? 0;
    if (totalIn === 0 && out === 0) return null;
    // Some routes flatten cached_tokens to top level; others nest it.
    const cached = u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;
    const cacheWrite = u.prompt_tokens_details?.cache_write_tokens ?? 0;
    const billableIn = Math.max(0, totalIn - cached);
    return {
        type: "usage",
        usage: {
            inputTokens: billableIn,
            outputTokens: out,
            ...(cached > 0 ? { cacheReadTokens: cached } : {}),
            ...(cacheWrite > 0 ? { cacheCreationTokens: cacheWrite } : {}),
            ...(typeof u.cost === "number" && u.cost >= 0 ? { costUsd: u.cost } : {}),
        },
    };
};

interface ChunkPayload {
    choices?: ReadonlyArray<ChunkChoice>;
    usage?: OpenRouterUsage;
    error?: OpenRouterErrorPayload;
}

export const formatOpenRouterError = (err: OpenRouterErrorPayload): string => {
    const parts: string[] = [];
    const base = err.message?.trim();
    if (base && base.length > 0) parts.push(base);
    else parts.push("unknown provider error");

    const detail: string[] = [];
    if (err.code !== undefined) detail.push(`code=${err.code}`);
    if (err.metadata?.provider_name) {
        detail.push(`provider=${err.metadata.provider_name}`);
    }
    if (detail.length > 0) parts.push(`(${detail.join(", ")})`);

    const raw = err.metadata?.raw?.trim();
    if (raw && raw.length > 0 && raw !== base) {
        const truncated = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
        parts.push(`— ${truncated}`);
    }
    const reasons = err.metadata?.reasons;
    if (Array.isArray(reasons) && reasons.length > 0) {
        parts.push(`reasons: ${reasons.join(", ")}`);
    }

    return parts.join(" ");
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

interface NonStreamMessage {
    role?: string;
    content?: string | null;
    reasoning?: string;
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
    usage?: OpenRouterUsage;
    error?: OpenRouterErrorPayload;
}

// Synthesize a one-shot event sequence from a non-streamed JSON response.
// Used by the recovery layer's stream→batch fallback.
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
            error: classifyMidStreamError(formatOpenRouterError(json.error)),
        };
        return;
    }

    const choice = json.choices?.[0];
    const message = choice?.message ?? {};
    const stopReason: StopReason = mapFinishReason(choice?.finish_reason);

    let reasoningOut = "";
    if (typeof message.reasoning === "string" && message.reasoning.length > 0) {
        reasoningOut = message.reasoning;
    } else if (
        typeof message.reasoning_content === "string" &&
        message.reasoning_content.length > 0
    ) {
        reasoningOut = message.reasoning_content;
    }
    if (reasoningOut.length > 0) {
        yield { type: "reasoning.delta", text: reasoningOut };
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
        const ev = buildOpenRouterUsageEvent(json.usage);
        if (ev) yield ev;
    }

    yield { type: "stop", reason: stopReason };
}

export async function* parseStream(response: Response): AsyncGenerator<ProviderEvent> {
    const toolCalls = new Map<number, ToolCallAccumulator>();
    let stopReason: StopReason = "end_turn";
    let errorPayload: ProviderError | undefined;
    let pendingUsage: OpenRouterUsage | undefined;

    for await (const data of sseDataLines(response)) {
        const chunk = safeParseJson(data);
        if (!chunk) continue;

        if (chunk.error) {
            stopReason = "error";
            errorPayload = classifyMidStreamError(formatOpenRouterError(chunk.error));
            break;
        }

        if (chunk.usage) pendingUsage = chunk.usage;

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};

        let reasoningOut = "";
        if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
            reasoningOut = delta.reasoning;
        } else if (
            typeof delta.reasoning_content === "string" &&
            delta.reasoning_content.length > 0
        ) {
            reasoningOut = delta.reasoning_content;
        } else if (Array.isArray(delta.reasoning_details)) {
            for (const d of delta.reasoning_details) {
                if (typeof d.text === "string") reasoningOut += d.text;
                else if (typeof d.summary === "string") reasoningOut += d.summary;
            }
        }
        if (reasoningOut.length > 0) {
            yield { type: "reasoning.delta", text: reasoningOut };
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

    if (pendingUsage) {
        const ev = buildOpenRouterUsageEvent(pendingUsage);
        if (ev) yield ev;
    }

    yield errorPayload !== undefined
        ? { type: "stop", reason: stopReason, error: errorPayload }
        : { type: "stop", reason: stopReason };
}
