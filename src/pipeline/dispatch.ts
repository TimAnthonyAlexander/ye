import type {
    Provider,
    ProviderError,
    ProviderInput,
    ProviderUsage,
    ReasoningDetail,
} from "../providers/index.ts";
import { computeCostUsd } from "../providers/pricing.ts";
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
    readonly usage?: ProviderUsage;
    readonly reasoningDetails?: readonly ReasoningDetail[];
}

export interface UsageReport {
    readonly provider: string;
    readonly model: string;
    readonly usage: ProviderUsage;
}

// Step 5 + early-step 6. Runs the model stream, yielding text deltas and
// tool-call events as they arrive. Returns the final result for the caller
// to use in steps 7–9.
export async function* streamFromProvider(
    provider: Provider,
    input: ProviderInput,
    onUsage?: (report: UsageReport) => void | Promise<void>,
): AsyncGenerator<Event, ModelStreamResult> {
    let text = "";
    const toolCalls: CollectedToolCall[] = [];
    let stopReason: ModelStreamResult["stopReason"] = "end_turn";
    let error: ProviderError | undefined;
    let usage: ProviderUsage | undefined;
    let reasoningDetails: readonly ReasoningDetail[] | undefined;

    for await (const evt of provider.stream(input)) {
        switch (evt.type) {
            case "text.delta":
                text += evt.text;
                yield { type: "model.text", delta: evt.text };
                break;
            case "reasoning.delta":
                yield { type: "model.reasoning", delta: evt.text };
                break;
            case "reasoning.complete":
                reasoningDetails = evt.details;
                yield { type: "model.reasoningDetails", details: evt.details };
                break;
            case "tool_call":
                toolCalls.push({ id: evt.id, name: evt.name, args: evt.args });
                yield { type: "model.toolCall", id: evt.id, name: evt.name, args: evt.args };
                break;
            case "usage": {
                // Stamp costUsd if the provider didn't supply one (Anthropic /
                // OpenAI direct). OpenRouter already sets it from usage.cost.
                const enriched: ProviderUsage =
                    evt.usage.costUsd === undefined
                        ? (() => {
                              const c = computeCostUsd(provider.id, input.model, evt.usage);
                              return c !== undefined ? { ...evt.usage, costUsd: c } : evt.usage;
                          })()
                        : evt.usage;
                usage = enriched;
                yield {
                    type: "model.usage",
                    provider: provider.id,
                    model: input.model,
                    usage: enriched,
                };
                if (onUsage) {
                    // Await so the disk record is committed before downstream
                    // turn.end consumers re-aggregate from the file.
                    await onUsage({ provider: provider.id, model: input.model, usage: enriched });
                }
                break;
            }
            case "stop":
                stopReason = evt.reason;
                if (evt.error) error = evt.error;
                break;
        }
    }

    const base: ModelStreamResult = {
        text,
        toolCalls,
        stopReason,
        ...(error !== undefined ? { error } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(reasoningDetails !== undefined ? { reasoningDetails } : {}),
    };
    return base;
}
