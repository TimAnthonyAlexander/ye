import type { Provider, ProviderError, ProviderInput } from "../providers/index.ts";
import type { Event } from "./events.ts";

export interface CollectedToolCall {
    readonly id: string;
    readonly name: string;
    readonly args: unknown;
}

export interface ModelStreamResult {
    readonly text: string;
    readonly toolCalls: readonly CollectedToolCall[];
    readonly stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" | "abort";
    readonly error?: ProviderError;
}

// Step 5 + early-step 6. Runs the model stream, yielding text deltas and
// tool-call events as they arrive. Returns the final result for the caller
// to use in steps 7–9.
export async function* streamFromProvider(
    provider: Provider,
    input: ProviderInput,
): AsyncGenerator<Event, ModelStreamResult> {
    let text = "";
    const toolCalls: CollectedToolCall[] = [];
    let stopReason: ModelStreamResult["stopReason"] = "end_turn";
    let error: ProviderError | undefined;

    for await (const evt of provider.stream(input)) {
        switch (evt.type) {
            case "text.delta":
                text += evt.text;
                yield { type: "model.text", delta: evt.text };
                break;
            case "reasoning.delta":
                yield { type: "model.reasoning", delta: evt.text };
                break;
            case "tool_call":
                toolCalls.push({ id: evt.id, name: evt.name, args: evt.args });
                yield { type: "model.toolCall", id: evt.id, name: evt.name, args: evt.args };
                break;
            case "stop":
                stopReason = evt.reason;
                if (evt.error) error = evt.error;
                break;
        }
    }

    return error !== undefined
        ? { text, toolCalls, stopReason, error }
        : { text, toolCalls, stopReason };
}
