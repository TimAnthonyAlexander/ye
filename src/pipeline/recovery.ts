import type { Config } from "../config/index.ts";
import { isRetryable } from "../providers/errors.ts";
import {
    getProvider,
    type Message,
    type Provider,
    type ToolDefinition,
} from "../providers/index.ts";
import { assemble } from "./assemble.ts";
import { type CollectedToolCall, type ModelStreamResult, streamFromProvider } from "./dispatch.ts";
import type { Event } from "./events.ts";
import type { RequestBudget } from "./shapers/index.ts";
import { runSummarizeAndReplace } from "./shapers/summarize.ts";
import type { SessionState } from "./state.ts";

export interface RecoveryInput {
    readonly state: SessionState;
    readonly config: Config;
    readonly initialProvider: Provider;
    readonly initialModel: string;
    readonly budget: RequestBudget;
    readonly initialMessages: Message[];
    readonly tools: readonly ToolDefinition[];
    readonly signal: AbortSignal;
    readonly providerOptions: Readonly<Record<string, unknown>>;
}

export interface RecoveryOutput {
    readonly result: ModelStreamResult;
    readonly finalProvider: Provider;
    readonly finalModel: string;
    readonly finalMessages: Message[];
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 8_000;
const MIN_REPLY_TOKEN_FLOOR = 1024;
const FORCE_SHAPER_PRESERVE_RECENT = 4;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });

// Force a summarize-and-replace run with a tight preserveRecent window. Bypasses
// the per-shaper one-shot flags — the prompt-too-long recovery path may need to
// shrink history even after a normal shaper already fired this turn.
const forceShaperEscalation = async (
    state: SessionState,
    provider: Provider,
    config: Config,
    model: string,
): Promise<boolean> => {
    if (state.history.length <= FORCE_SHAPER_PRESERVE_RECENT) return false;
    const outcome = await runSummarizeAndReplace(
        {
            state,
            provider,
            config,
            model,
            messages: [],
            budget: {
                maxTokens: 0,
                initialMaxTokens: 0,
                tokensFreedThisTurn: 0,
            },
        },
        {
            preserveRecent: FORCE_SHAPER_PRESERVE_RECENT,
            promptStyle: "auto-compact",
        },
    );
    return outcome.result === "applied";
};

const buildEmptyResult = (): ModelStreamResult => ({
    text: "",
    toolCalls: [] as readonly CollectedToolCall[],
    stopReason: "error",
});

// Wraps streamFromProvider with a retry orchestrator. Yields events live —
// including recovery.retry events the UI can render. Retries only fire when no
// content was emitted in the failing attempt; once any text or tool_call has
// streamed, the result is committed as-is (re-streaming would produce duplicate
// output in the UI).
export async function* runModelCallWithRecovery(
    input: RecoveryInput,
): AsyncGenerator<Event, RecoveryOutput> {
    const recoveryCfg = input.config.recovery ?? {};
    const maxRetries = recoveryCfg.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseMs = recoveryCfg.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const maxMs = recoveryCfg.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;

    let provider = input.initialProvider;
    let model = input.initialModel;
    let messages = input.initialMessages;
    let attempt = 0;
    let triedNonStreaming = false;
    let triedFallbackModel = false;
    let triedShaperEscalation = false;
    let useStreaming = true;

    while (true) {
        const streamGen = streamFromProvider(provider, {
            model,
            messages,
            tools: input.tools,
            signal: input.signal,
            maxTokens: input.budget.maxTokens,
            stream: useStreaming,
            providerOptions: input.providerOptions,
        });

        let result: ModelStreamResult = buildEmptyResult();
        while (true) {
            const next = await streamGen.next();
            if (next.done) {
                result = next.value;
                break;
            }
            yield next.value;
        }

        if (result.stopReason !== "error") {
            return {
                result,
                finalProvider: provider,
                finalModel: model,
                finalMessages: messages,
            };
        }

        const err = result.error;
        const wasContentEmitted = result.text.length > 0 || result.toolCalls.length > 0;

        // Terminal: missing classification, content already streamed (replay
        // would be confusing), non-retryable kind, or retry budget exhausted.
        if (!err || wasContentEmitted || !isRetryable(err) || attempt >= maxRetries) {
            return {
                result,
                finalProvider: provider,
                finalModel: model,
                finalMessages: messages,
            };
        }

        // Strategy 1: max_tokens parameter rejected — halve and retry.
        if (err.kind === "max_tokens_invalid") {
            const lowered = Math.max(MIN_REPLY_TOKEN_FLOOR, Math.floor(input.budget.maxTokens / 2));
            if (lowered >= input.budget.maxTokens) {
                return {
                    result,
                    finalProvider: provider,
                    finalModel: model,
                    finalMessages: messages,
                };
            }
            input.budget.maxTokens = lowered;
            attempt += 1;
            yield {
                type: "recovery.retry",
                attempt,
                kind: err.kind,
                action: "lowered_max_tokens",
            };
            continue;
        }

        // Strategy 2: stream_error — first retry uses non-streaming. The
        // transport switch is a free retry (no attempt-counter bump).
        if (err.kind === "stream_error" && !triedNonStreaming) {
            triedNonStreaming = true;
            useStreaming = false;
            yield {
                type: "recovery.retry",
                attempt: attempt + 1,
                kind: err.kind,
                action: "non_streaming",
            };
            continue;
        }

        // Strategy 3: prompt_too_long — force a shaper to shrink history,
        // re-assemble, then retry.
        if (err.kind === "prompt_too_long" && !triedShaperEscalation) {
            triedShaperEscalation = true;
            const forced = await forceShaperEscalation(input.state, provider, input.config, model);
            if (!forced) {
                return {
                    result,
                    finalProvider: provider,
                    finalModel: model,
                    finalMessages: messages,
                };
            }
            messages = await assemble({ state: input.state, model });
            attempt += 1;
            yield {
                type: "recovery.retry",
                attempt,
                kind: err.kind,
                action: "force_shaper",
            };
            continue;
        }

        // Strategy 4: persistent error — try the configured fallback model
        // before exhausting the retry budget. One shot.
        if (
            !triedFallbackModel &&
            input.config.recovery?.fallbackModel &&
            attempt + 1 >= Math.max(1, maxRetries - 1)
        ) {
            const fb = input.config.recovery.fallbackModel;
            triedFallbackModel = true;
            try {
                if (fb.provider !== provider.id) {
                    provider = getProvider(input.config, fb.provider);
                }
                model = fb.model;
                attempt += 1;
                yield {
                    type: "recovery.retry",
                    attempt,
                    kind: err.kind,
                    action: "fallback_model",
                };
                continue;
            } catch {
                // Fallback build failed (likely missing key for that provider);
                // surface the original error.
                return {
                    result,
                    finalProvider: provider,
                    finalModel: model,
                    finalMessages: messages,
                };
            }
        }

        // Strategy 5: backoff and retry the same call.
        const wait = Math.min(maxMs, baseMs * 2 ** attempt);
        attempt += 1;
        yield {
            type: "recovery.retry",
            attempt,
            kind: err.kind,
            action: "backoff",
            waitMs: wait,
        };
        await sleep(wait, input.signal);
        if (input.signal.aborted) {
            return {
                result: { ...result, stopReason: "abort" },
                finalProvider: provider,
                finalModel: model,
                finalMessages: messages,
            };
        }
    }
}
