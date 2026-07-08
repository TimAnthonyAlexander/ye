import type {
    Provider,
    ProviderError,
    ProviderEvent,
    ProviderInput,
    ProviderUsage,
    ReasoningDetail,
} from "../providers/index.ts";
import { computeCostUsd } from "../providers/pricing.ts";
import type { Event } from "./events.ts";

// A provider stream can stall with the connection open but no bytes, no close,
// and no error — which would hang this loop and every caller above it (turn,
// queryLoop, a background subagent's runInProcess) forever. Bound the gap
// between chunks. For non-streaming requests the single await legitimately
// spans the whole generation, so it gets a larger total budget instead.
const STREAM_STALL_TIMEOUT_MS = 180_000;
const NONSTREAM_TIMEOUT_MS = 300_000;

class StreamStallError extends Error {
    constructor(ms: number) {
        super(`provider stream stalled — no data for ${Math.round(ms / 1000)}s`);
        this.name = "StreamStallError";
    }
}

// Resolve `p`, but reject with StreamStallError (and fire `onTimeout`, which
// aborts the request) if it doesn't settle within `ms`. The abandoned promise
// is caught so the later abort-driven rejection isn't unhandled.
const raceStall = <T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> => {
    p.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            onTimeout();
            reject(new StreamStallError(ms));
        }, ms);
    });
    return Promise.race([p, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
    }) as Promise<T>;
};

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
    stallTimeoutMs: number = STREAM_STALL_TIMEOUT_MS,
): AsyncGenerator<Event, ModelStreamResult> {
    let text = "";
    const toolCalls: CollectedToolCall[] = [];
    let stopReason: ModelStreamResult["stopReason"] = "end_turn";
    let error: ProviderError | undefined;
    let usage: ProviderUsage | undefined;
    let reasoningDetails: readonly ReasoningDetail[] | undefined;

    // Drive the provider stream through a derived signal so a stall aborts only
    // this attempt (the parent stays live for recovery retries). Each chunk
    // resets the inactivity budget; a stall surfaces as a retryable stream_error.
    const stepTimeoutMs = input.stream === false ? NONSTREAM_TIMEOUT_MS : stallTimeoutMs;
    const controller = new AbortController();
    const parentSignal = input.signal;
    const onParentAbort = (): void => controller.abort();
    if (parentSignal) {
        if (parentSignal.aborted) controller.abort();
        else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
    const iter = provider.stream({ ...input, signal: controller.signal })[Symbol.asyncIterator]();

    try {
        while (true) {
            let step: IteratorResult<ProviderEvent>;
            try {
                step = await raceStall(iter.next(), stepTimeoutMs, () => controller.abort());
            } catch (e) {
                if (e instanceof StreamStallError && !parentSignal?.aborted) {
                    stopReason = "error";
                    error = { kind: "stream_error", message: e.message, retryable: true };
                    break;
                }
                throw e;
            }
            if (step.done) break;
            const evt = step.value;
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
                        await onUsage({
                            provider: provider.id,
                            model: input.model,
                            usage: enriched,
                        });
                    }
                    break;
                }
                case "stop":
                    stopReason = evt.reason;
                    if (evt.error) error = evt.error;
                    break;
            }
        }
    } finally {
        if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
        void iter.return?.().catch(() => {});
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
