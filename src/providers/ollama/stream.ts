import { classifyMidStreamError } from "../errors.ts";
import type { ProviderError, ProviderEvent, ProviderUsage, StopReason } from "../types.ts";
import { ndjsonLines } from "./ndjson.ts";

interface OllamaToolCall {
    type?: "function";
    function?: {
        index?: number;
        name?: string;
        arguments?: unknown;
    };
}

interface OllamaMessageChunk {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: ReadonlyArray<OllamaToolCall>;
}

interface OllamaChunk {
    model?: string;
    created_at?: string;
    message?: OllamaMessageChunk;
    response?: string; // /api/generate variant — unused in /api/chat path
    done?: boolean;
    done_reason?: string;
    error?: string;
    prompt_eval_count?: number;
    eval_count?: number;
}

const safeParseJson = (raw: string): OllamaChunk | null => {
    try {
        return JSON.parse(raw) as OllamaChunk;
    } catch {
        return null;
    }
};

const buildUsage = (inputTokens: number, outputTokens: number): ProviderUsage => ({
    inputTokens,
    outputTokens,
});

const mapDoneReason = (raw: string | undefined, hasToolCalls: boolean): StopReason => {
    if (hasToolCalls) return "tool_use";
    switch (raw) {
        case "stop":
            return "end_turn";
        case "length":
            return "max_tokens";
        case "load":
        case "unload":
            return "end_turn";
        default:
            return "end_turn";
    }
};

interface AccumulatedToolCall {
    id: string;
    name: string;
    args: unknown;
}

const collectToolCalls = (
    seen: AccumulatedToolCall[],
    incoming: ReadonlyArray<OllamaToolCall> | undefined,
): void => {
    if (!incoming) return;
    for (const tc of incoming) {
        const fn = tc.function;
        if (!fn || typeof fn.name !== "string" || fn.name.length === 0) continue;
        seen.push({
            id: `call_${seen.length}`,
            name: fn.name,
            args: fn.arguments ?? {},
        });
    }
};

// Synthesize a one-shot event sequence from a non-streamed JSON response.
// Used by the recovery layer's stream→batch fallback.
export async function* parseBatch(response: Response): AsyncGenerator<ProviderEvent> {
    let json: OllamaChunk;
    try {
        json = (await response.json()) as OllamaChunk;
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
            error: classifyMidStreamError(json.error),
        };
        return;
    }

    const message = json.message ?? {};
    if (typeof message.thinking === "string" && message.thinking.length > 0) {
        yield { type: "reasoning.delta", text: message.thinking };
    }
    if (typeof message.content === "string" && message.content.length > 0) {
        yield { type: "text.delta", text: message.content };
    }

    const calls: AccumulatedToolCall[] = [];
    collectToolCalls(calls, message.tool_calls);
    for (const c of calls) {
        yield { type: "tool_call", id: c.id, name: c.name, args: c.args };
    }

    const inputTokens = json.prompt_eval_count ?? 0;
    const outputTokens = json.eval_count ?? 0;
    if (inputTokens > 0 || outputTokens > 0) {
        yield { type: "usage", usage: buildUsage(inputTokens, outputTokens) };
    }

    yield { type: "stop", reason: mapDoneReason(json.done_reason, calls.length > 0) };
}

// Ollama NDJSON → Ye ProviderEvent stream.
// Each line is a complete JSON object. Text and reasoning arrive incrementally
// via `message.content` / `message.thinking` on every chunk. Tool calls may
// arrive on one or more chunks before the terminating `done: true` chunk. The
// final chunk carries timing/eval stats.
export async function* parseStream(response: Response): AsyncGenerator<ProviderEvent> {
    const calls: AccumulatedToolCall[] = [];
    let stopReason: StopReason = "end_turn";
    let errorPayload: ProviderError | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;

    for await (const data of ndjsonLines(response)) {
        const chunk = safeParseJson(data);
        if (!chunk) continue;

        if (chunk.error) {
            stopReason = "error";
            errorPayload = classifyMidStreamError(chunk.error);
            break;
        }

        const message = chunk.message;
        if (message) {
            if (typeof message.thinking === "string" && message.thinking.length > 0) {
                yield { type: "reasoning.delta", text: message.thinking };
            }
            if (typeof message.content === "string" && message.content.length > 0) {
                yield { type: "text.delta", text: message.content };
            }
            collectToolCalls(calls, message.tool_calls);
        }

        if (chunk.done) {
            if (typeof chunk.prompt_eval_count === "number") {
                inputTokens = chunk.prompt_eval_count;
                sawUsage = true;
            }
            if (typeof chunk.eval_count === "number") {
                outputTokens = chunk.eval_count;
                sawUsage = true;
            }
            stopReason = mapDoneReason(chunk.done_reason, calls.length > 0);
            break;
        }
    }

    for (const c of calls) {
        yield { type: "tool_call", id: c.id, name: c.name, args: c.args };
    }

    if (sawUsage) {
        yield { type: "usage", usage: buildUsage(inputTokens, outputTokens) };
    }

    yield errorPayload !== undefined
        ? { type: "stop", reason: stopReason, error: errorPayload }
        : { type: "stop", reason: stopReason };
}
