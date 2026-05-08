import { classifyMidStreamError } from "../errors.ts";
import { sseDataLines } from "../sse.ts";
import type { ProviderError, ProviderEvent, StopReason } from "../types.ts";

interface ToolUseAccumulator {
    id: string;
    name: string;
    args: string;
}

interface AnthropicStreamEvent {
    type: string;
    index?: number;
    content_block?: {
        type?: string;
        id?: string;
        name?: string;
        input?: unknown;
    };
    delta?: {
        type?: string;
        text?: string;
        partial_json?: string;
        thinking?: string;
        signature?: string;
        stop_reason?: string;
        stop_sequence?: string | null;
    };
    error?: { type?: string; message?: string };
}

const mapStopReason = (raw: string | null | undefined): StopReason => {
    switch (raw) {
        case "end_turn":
        case "stop_sequence":
        case "pause_turn":
            return "end_turn";
        case "tool_use":
            return "tool_use";
        case "max_tokens":
            return "max_tokens";
        case "refusal":
            return "error";
        default:
            return "end_turn";
    }
};

const safeParseJson = (raw: string): AnthropicStreamEvent | null => {
    try {
        return JSON.parse(raw) as AnthropicStreamEvent;
    } catch {
        return null;
    }
};

interface AnthropicBatchContentBlock {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
}

interface AnthropicBatchResponse {
    type?: string;
    content?: ReadonlyArray<AnthropicBatchContentBlock>;
    stop_reason?: string | null;
    error?: { type?: string; message?: string };
}

// Synthesize a one-shot event sequence from a non-streamed JSON response.
// Used by the recovery layer's stream→batch fallback.
export async function* parseBatch(response: Response): AsyncGenerator<ProviderEvent> {
    let json: AnthropicBatchResponse;
    try {
        json = (await response.json()) as AnthropicBatchResponse;
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
            error: classifyMidStreamError(json.error.message ?? "unknown provider error"),
        };
        return;
    }

    const stopReason = mapStopReason(json.stop_reason);

    for (const block of json.content ?? []) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            yield { type: "text.delta", text: block.text };
        } else if (block.type === "tool_use" && block.id && block.name) {
            yield { type: "tool_call", id: block.id, name: block.name, args: block.input ?? {} };
        }
    }

    yield { type: "stop", reason: stopReason };
}

// Anthropic SSE → Ye ProviderEvent stream.
// Event flow:
//   message_start → content_block_start (text) → content_block_delta (text_delta...)
//                 → content_block_stop → [more blocks at higher indexes]
//   message_delta (carries stop_reason) → message_stop
// tool_use blocks accumulate input via input_json_delta and are emitted at the
// end once stop_reason is known to be tool_use.
export async function* parseStream(response: Response): AsyncGenerator<ProviderEvent> {
    const toolBlocks = new Map<number, ToolUseAccumulator>();
    let stopReason: StopReason = "end_turn";
    let errorPayload: ProviderError | undefined;

    for await (const data of sseDataLines(response)) {
        const evt = safeParseJson(data);
        if (!evt) continue;

        switch (evt.type) {
            case "content_block_start": {
                const idx = evt.index ?? 0;
                const cb = evt.content_block;
                if (cb && cb.type === "tool_use" && cb.id && cb.name) {
                    toolBlocks.set(idx, { id: cb.id, name: cb.name, args: "" });
                }
                break;
            }
            case "content_block_delta": {
                const idx = evt.index ?? 0;
                const d = evt.delta;
                if (!d) break;
                if (d.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
                    yield { type: "text.delta", text: d.text };
                } else if (
                    d.type === "thinking_delta" &&
                    typeof d.thinking === "string" &&
                    d.thinking.length > 0
                ) {
                    yield { type: "reasoning.delta", text: d.thinking };
                } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
                    const acc = toolBlocks.get(idx);
                    if (acc) acc.args += d.partial_json;
                }
                // signature_delta / citations_delta — ignored for v1.
                break;
            }
            case "message_delta": {
                const reason = evt.delta?.stop_reason;
                if (reason) stopReason = mapStopReason(reason);
                break;
            }
            case "error": {
                stopReason = "error";
                errorPayload = classifyMidStreamError(
                    evt.error?.message ?? "unknown provider error",
                );
                break;
            }
            // message_start, content_block_stop, ping, message_stop — no-op.
        }

        if (evt.type === "error") break;
    }

    if (stopReason === "tool_use") {
        for (const block of toolBlocks.values()) {
            let args: unknown;
            try {
                args = JSON.parse(block.args.length > 0 ? block.args : "{}");
            } catch {
                args = { _raw: block.args };
            }
            yield { type: "tool_call", id: block.id, name: block.name, args };
        }
    }

    yield errorPayload !== undefined
        ? { type: "stop", reason: stopReason, error: errorPayload }
        : { type: "stop", reason: stopReason };
}
