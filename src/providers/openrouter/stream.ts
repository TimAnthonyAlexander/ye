import { classifyMidStreamError } from "../errors.ts";
import { sseDataLines } from "../sse.ts";
import type {
    ProviderError,
    ProviderEvent,
    ReasoningDetail,
    ReasoningFormat,
    StopReason,
} from "../types.ts";

interface ToolCallAccumulator {
    id?: string;
    name?: string;
    args: string;
}

// Wire-shape from OpenRouter's reasoning_details[]. All fields optional —
// the type discriminator is `type` and varies by upstream provider.
interface WireReasoningDetail {
    type?: string;
    text?: string;
    signature?: string;
    summary?: string;
    data?: string;
    format?: string;
    id?: string;
    index?: number;
}

const KNOWN_FORMATS: readonly ReasoningFormat[] = [
    "unknown",
    "openai-responses-v1",
    "azure-openai-responses-v1",
    "xai-responses-v1",
    "anthropic-claude-v1",
    "google-gemini-v1",
];

const isKnownFormat = (s: string): s is ReasoningFormat =>
    (KNOWN_FORMATS as readonly string[]).includes(s);

// Convert one wire reasoning_details entry into the typed ReasoningDetail
// union. Unknown types are dropped (they wouldn't round-trip safely anyway).
const toTypedDetail = (raw: WireReasoningDetail): ReasoningDetail | null => {
    const base: { id?: string; format?: ReasoningFormat; index?: number } = {};
    if (typeof raw.id === "string") base.id = raw.id;
    if (typeof raw.format === "string" && isKnownFormat(raw.format)) base.format = raw.format;
    if (typeof raw.index === "number") base.index = raw.index;

    switch (raw.type) {
        case "reasoning.text": {
            const text = typeof raw.text === "string" ? raw.text : "";
            const out: ReasoningDetail = { ...base, type: "reasoning.text", text };
            if (typeof raw.signature === "string") {
                return { ...out, signature: raw.signature };
            }
            return out;
        }
        case "reasoning.encrypted": {
            if (typeof raw.data !== "string") return null;
            return { ...base, type: "reasoning.encrypted", data: raw.data };
        }
        case "reasoning.summary": {
            if (typeof raw.summary !== "string") return null;
            return { ...base, type: "reasoning.summary", summary: raw.summary };
        }
        default:
            return null;
    }
};

// Accumulator for stream-deltas of reasoning_details. Each delta carries an
// `index` and a partial slice (e.g. text grows token-by-token). We collect
// per-index and merge text/summary fields incrementally, preserving emission
// order.
class ReasoningDetailsAccumulator {
    private readonly byIndex = new Map<number, WireReasoningDetail>();
    private readonly orderedIndices: number[] = [];
    private nextSyntheticIndex = 0;

    push(raw: WireReasoningDetail): void {
        const idx = typeof raw.index === "number" ? raw.index : this.nextSyntheticIndex++;
        const existing = this.byIndex.get(idx);
        if (!existing) {
            this.orderedIndices.push(idx);
            this.byIndex.set(idx, { ...raw, index: idx });
            return;
        }
        const merged: WireReasoningDetail = { ...existing };
        if (typeof raw.type === "string") merged.type = raw.type;
        if (typeof raw.id === "string") merged.id = raw.id;
        if (typeof raw.format === "string") merged.format = raw.format;
        if (typeof raw.signature === "string") merged.signature = raw.signature;
        if (typeof raw.data === "string") merged.data = raw.data;
        if (typeof raw.text === "string") merged.text = (merged.text ?? "") + raw.text;
        if (typeof raw.summary === "string") merged.summary = (merged.summary ?? "") + raw.summary;
        this.byIndex.set(idx, merged);
    }

    finalize(): readonly ReasoningDetail[] {
        const out: ReasoningDetail[] = [];
        for (const idx of this.orderedIndices) {
            const raw = this.byIndex.get(idx);
            if (!raw) continue;
            const typed = toTypedDetail(raw);
            if (typed !== null) out.push(typed);
        }
        return out;
    }
}

interface ChunkChoiceDelta {
    role?: string;
    content?: string;
    reasoning?: string;
    reasoning_content?: string;
    reasoning_details?: ReadonlyArray<WireReasoningDetail>;
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

const buildOpenRouterUsageEvent = (u: OpenRouterUsage, upstream?: string): ProviderEvent | null => {
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
            ...(upstream ? { upstream } : {}),
        },
    };
};

interface ChunkPayload {
    choices?: ReadonlyArray<ChunkChoice>;
    usage?: OpenRouterUsage;
    error?: OpenRouterErrorPayload;
    provider?: string;
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
    reasoning_details?: ReadonlyArray<WireReasoningDetail>;
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
    provider?: string;
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

    if (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0) {
        const acc = new ReasoningDetailsAccumulator();
        for (const d of message.reasoning_details) acc.push(d);
        const details = acc.finalize();
        if (details.length > 0) yield { type: "reasoning.complete", details };
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
        const ev = buildOpenRouterUsageEvent(json.usage, json.provider);
        if (ev) yield ev;
    }

    yield { type: "stop", reason: stopReason };
}

export async function* parseStream(response: Response): AsyncGenerator<ProviderEvent> {
    const toolCalls = new Map<number, ToolCallAccumulator>();
    const reasoningAcc = new ReasoningDetailsAccumulator();
    let upstreamProvider: string | undefined;
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
        if (typeof chunk.provider === "string" && chunk.provider.length > 0) {
            upstreamProvider = chunk.provider;
        }

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

        if (Array.isArray(delta.reasoning_details)) {
            for (const d of delta.reasoning_details) reasoningAcc.push(d);
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

    const finalizedDetails = reasoningAcc.finalize();
    if (finalizedDetails.length > 0) {
        yield { type: "reasoning.complete", details: finalizedDetails };
    }

    if (pendingUsage) {
        const ev = buildOpenRouterUsageEvent(pendingUsage, upstreamProvider);
        if (ev) yield ev;
    }

    yield errorPayload !== undefined
        ? { type: "stop", reason: stopReason, error: errorPayload }
        : { type: "stop", reason: stopReason };
}
