import { classifyMidStreamError } from "../errors.ts";
import { sseDataLines } from "../sse.ts";
import type { ProviderEvent, StopReason, ProviderError } from "../types.ts";

interface ToolCallAccumulator {
    id: string;
    call_id: string;
    name: string;
    args: string;
}

interface OpenAIEvent {
    type: string;
    delta?: string;
    call_id?: string;
    name?: string;
    args?: string;
    status?: string;
    error?: { message: string; code?: string };
    response?: {
        status: string;
        output?: any[];
    };
}

const mapStopReason = (status?: string): StopReason => {
    switch (status) {
        case "completed":
            return "end_turn";
        case "incomplete":
            return "max_tokens";
        case "failed":
            return "error";
        default:
            return "end_turn";
    }
};

export async function* parseBatch(response: Response): AsyncGenerator<ProviderEvent> {
    let json: any;
    try {
        json = await response.json();
    } catch (err) {
        yield {
            type: "stop",
            reason: "error",
            error: classifyMidStreamError(`failed to parse non-streaming response: ${err}`),
        };
        return;
    }

    if (json.error) {
        yield {
            type: "stop",
            reason: "error",
            error: classifyMidStreamError(json.error.message),
        };
        return;
    }

    // Process output items
    if (Array.isArray(json.output)) {
        for (const item of json.output) {
            if (item.type === "message" && item.role === "assistant") {
                if (Array.isArray(item.content)) {
                    for (const part of item.content) {
                        if (part.type === "output_text") {
                            yield { type: "text.delta", text: part.text };
                        }
                    }
                }
            } else if (item.type === "function_call") {
                let args: unknown;
                try {
                    args = JSON.parse(item.arguments || "{}");
                } catch {
                    args = { _raw: item.arguments };
                }
                yield { type: "tool_call", id: item.call_id, name: item.name, args };
            }
        }
    }

    yield { type: "stop", reason: mapStopReason(json.status) };
}

export async function* parseStream(response: Response): AsyncGenerator<ProviderEvent> {
    const toolCalls = new Map<string, ToolCallAccumulator>();
    let stopReason: StopReason = "end_turn";
    let errorPayload: ProviderError | undefined;

    for await (const data of sseDataLines(response)) {
        let event: OpenAIEvent;
        try {
            event = JSON.parse(data);
        } catch {
            continue;
        }

        switch (event.type) {
            case "response.output_text.delta":
                if (event.delta) {
                    yield { type: "text.delta", text: event.delta };
                }
                break;

            case "response.reasoning_summary_text.delta":
                if (event.delta) {
                    yield { type: "reasoning.delta", text: event.delta };
                }
                break;

            case "response.output_item.added":
                // If it's a function call, start tracking it
                const item = (event as any).item;
                if (item?.type === "function_call") {
                    toolCalls.set(item.id, {
                        id: item.id,
                        call_id: item.call_id,
                        name: item.name,
                        args: "",
                    });
                }
                break;

            case "response.function_call_arguments.delta":
                const acc = toolCalls.get((event as any).item_id);
                if (acc && event.delta) {
                    acc.args += event.delta;
                }
                break;

            case "response.function_call_arguments.done":
                const finalAcc = toolCalls.get((event as any).item_id);
                if (finalAcc) {
                    let args: unknown;
                    try {
                        args = JSON.parse(finalAcc.args || "{}");
                    } catch {
                        args = { _raw: finalAcc.args };
                    }
                    yield {
                        type: "tool_call",
                        id: finalAcc.call_id,
                        name: finalAcc.name,
                        args,
                    };
                }
                break;

            case "response.failed":
                stopReason = "error";
                errorPayload = classifyMidStreamError(
                    (event as any).error?.message || "OpenAI Response Failed",
                );
                break;

            case "response.completed":
                stopReason = mapStopReason(event.response?.status);
                break;

            case "response.incomplete":
                stopReason = "max_tokens";
                break;

            case "error":
                stopReason = "error";
                errorPayload = classifyMidStreamError(event.error?.message || "Transport Error");
                break;
        }
    }

    yield errorPayload !== undefined
        ? { type: "stop", reason: stopReason, error: errorPayload }
        : { type: "stop", reason: stopReason };
}
