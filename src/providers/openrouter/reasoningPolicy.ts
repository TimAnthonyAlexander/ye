import type { Message, ReasoningDetail } from "../types.ts";

// Per-model policy for OpenRouter routes. Drives two decisions:
//   1. Whether to round-trip reasoning_details from prior assistant messages
//      back into the next request body (input policy).
//   2. Default reasoning.effort and which levels the upstream actually accepts
//      (effort policy).
//
// Policy levels:
//   - "required": upstream returns 400 if reasoning_details are absent on any
//     prior assistant message once reasoning was emitted (DeepSeek V4 Pro,
//     Gemini 3 on tool turns).
//   - "preserve": round-trip is recommended for quality; silent degradation if
//     dropped, no API error. Default for most modern reasoning models.
//   - "reject": upstream returns 400 if reasoning_details are present in input
//     (DeepSeek R1).
//
// Required-on-tool-turns variant captures Gemini 3's split behavior: full
// "required" when any assistant in history has tool_calls; "preserve"
// otherwise.

export type InputPolicyLevel = "required" | "preserve" | "reject";

export interface EffortPolicy {
    readonly default: "low" | "medium" | "high" | "max" | null;
    readonly supported: readonly ("low" | "medium" | "high" | "max")[];
    readonly canDisable: boolean;
}

export interface ReasoningPolicyEntry {
    readonly input: InputPolicyLevel | "required-on-tool-turns";
    readonly effort: EffortPolicy;
}

interface MatrixRow {
    readonly match: (modelId: string) => boolean;
    readonly entry: ReasoningPolicyEntry;
}

const startsWithAny = (id: string, prefixes: readonly string[]): boolean =>
    prefixes.some((p) => id.startsWith(p));

// Order matters — first match wins. More specific patterns must come before
// looser ones.
const MATRIX: readonly MatrixRow[] = [
    // DeepSeek R1 family — input rejects reasoning_details on input.
    {
        match: (id) => startsWithAny(id, ["deepseek/deepseek-r1", "deepseek/deepseek-reasoner"]),
        entry: {
            input: "reject",
            effort: {
                default: "high",
                supported: ["high"],
                canDisable: false,
            },
        },
    },
    // DeepSeek V4 Pro via OpenRouter — preserve only.
    //
    // V4 Pro's *native* API requires reasoning_content round-trip within a
    // tool-call sub-loop (else HTTP 400). However, OpenRouter strips reasoning
    // fields before forwarding to every V4 Pro upstream we tested EXCEPT
    // DeepInfra, which has a 66k context window. Empirically verified via
    // `scripts/debug-reasoning-v5.ts`. So this route can never honor the
    // consistency requirement reliably — round-trip is a silent no-op on most
    // upstreams. Use the native DeepSeek provider for actual reasoning
    // preservation.
    {
        match: (id) => startsWithAny(id, ["deepseek/deepseek-v4-pro"]),
        entry: {
            input: "preserve",
            effort: {
                default: "high",
                supported: ["high", "max"],
                canDisable: false,
            },
        },
    },
    // DeepSeek V4 Flash / other DeepSeek thinking models — preserve.
    {
        match: (id) => startsWithAny(id, ["deepseek/deepseek-v4"]),
        entry: {
            input: "preserve",
            effort: {
                default: "high",
                supported: ["low", "medium", "high"],
                canDisable: true,
            },
        },
    },
    // Gemini 3.x Pro / Flash — required on tool turns. Pro can't disable
    // thinking; only low/high are distinct levels (medium maps internally).
    {
        match: (id) => id.startsWith("google/gemini-3") || id.startsWith("~google/gemini-3"),
        entry: {
            input: "required-on-tool-turns",
            effort: {
                default: "high",
                supported: ["low", "high"],
                canDisable: false,
            },
        },
    },
    // Gemini 2.5 family — preserve. Uses max_tokens budget rather than levels.
    {
        match: (id) => id.startsWith("google/gemini-2.5") || id.startsWith("~google/gemini-2.5"),
        entry: {
            input: "preserve",
            effort: {
                default: null,
                supported: [],
                canDisable: true,
            },
        },
    },
    // Gemini Flash "latest" alias — conservative preserve until the alias
    // resolves to 3.x in the wild (at which point bump to required-on-tool-turns).
    {
        match: (id) => id.endsWith("/gemini-flash-latest") || id.endsWith("/gemini-pro-latest"),
        entry: {
            input: "preserve",
            effort: {
                default: "high",
                supported: ["low", "high"],
                canDisable: true,
            },
        },
    },
    // Anthropic models via OpenRouter — preserve (signatures must round-trip
    // unchanged during tool-use chains; for plain turns it's recommended for
    // cache stability on Opus 4.5+ / Sonnet 4.6+).
    {
        match: (id) => id.startsWith("anthropic/claude"),
        entry: {
            input: "preserve",
            effort: {
                default: "high",
                supported: ["low", "medium", "high"],
                canDisable: true,
            },
        },
    },
    // MiniMax M2.x — preserve. Quality degrades silently on long agentic
    // chains when reasoning is dropped; round-trip is recommended.
    {
        match: (id) => id.startsWith("minimax/minimax-m2"),
        entry: {
            input: "preserve",
            effort: {
                default: "high",
                supported: ["low", "medium", "high"],
                canDisable: true,
            },
        },
    },
    // OpenAI o-series / GPT-5+ via OpenRouter — preserve (encrypted blobs
    // need to ride along for the model to maintain state).
    {
        match: (id) =>
            id.startsWith("openai/o") ||
            id.startsWith("openai/gpt-5") ||
            id.startsWith("openai/gpt-6"),
        entry: {
            input: "preserve",
            effort: {
                default: "high",
                supported: ["low", "medium", "high"],
                canDisable: true,
            },
        },
    },
    // xAI Grok reasoning — preserve.
    {
        match: (id) => id.startsWith("x-ai/grok"),
        entry: {
            input: "preserve",
            effort: {
                default: "high",
                supported: ["low", "medium", "high"],
                canDisable: true,
            },
        },
    },
    // Qwen 3.x+ / Kimi K2 Thinking / GLM 4.5+ / Nemotron — preserve.
    {
        match: (id) =>
            id.startsWith("qwen/qwen") ||
            id.startsWith("moonshotai/kimi-k2") ||
            id.startsWith("z-ai/glm-4") ||
            id.startsWith("nvidia/nemotron"),
        entry: {
            input: "preserve",
            effort: {
                default: "high",
                supported: ["low", "medium", "high"],
                canDisable: true,
            },
        },
    },
];

const DEFAULT_ENTRY: ReasoningPolicyEntry = {
    input: "preserve",
    effort: {
        default: "high",
        supported: ["low", "medium", "high"],
        canDisable: true,
    },
};

export const getReasoningPolicy = (modelId: string): ReasoningPolicyEntry => {
    for (const row of MATRIX) {
        if (row.match(modelId)) return row.entry;
    }
    return DEFAULT_ENTRY;
};

const historyHasToolCalls = (messages: readonly Message[]): boolean =>
    messages.some(
        (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );

// Resolve the effective input policy for a given turn. Collapses the
// "required-on-tool-turns" intermediate state based on whether any assistant
// message in history carries tool_calls — Gemini 3's requirement only
// applies once tool use enters the conversation.
export const resolveInputPolicy = (
    modelId: string,
    messages: readonly Message[],
): InputPolicyLevel => {
    const { input } = getReasoningPolicy(modelId);
    if (input === "required-on-tool-turns") {
        return historyHasToolCalls(messages) ? "required" : "preserve";
    }
    return input;
};

// Apply policy to the outgoing message array. Pure function — returns a new
// array with new message objects when stripping is needed, otherwise the
// input is returned by reference.
//
// "reject"   → strip reasoning_details from every assistant message.
// "preserve" → pass through unchanged (best-effort round-trip).
// "required" → enforce all-or-nothing: if any assistant message carries
//              reasoning_details, every assistant message must. If any are
//              missing, strip all to avoid a 400 on inconsistency. The next
//              turn's response will re-seed the field on the new assistant
//              message and consistency is restored from that point.
export const applyInputPolicy = (
    modelId: string,
    messages: readonly Message[],
): readonly Message[] => {
    const policy = resolveInputPolicy(modelId, messages);

    if (policy === "preserve") return messages;

    if (policy === "reject") {
        const hasAny = messages.some(
            (m) =>
                m.role === "assistant" &&
                Array.isArray(m.reasoning_details) &&
                m.reasoning_details.length > 0,
        );
        if (!hasAny) return messages;
        return messages.map(stripReasoningDetails);
    }

    // required: drop all if any assistant is missing the field.
    const assistants = messages.filter((m) => m.role === "assistant");
    const haveCount = assistants.filter(
        (m) => Array.isArray(m.reasoning_details) && m.reasoning_details.length > 0,
    ).length;

    if (haveCount === 0) return messages;
    if (haveCount === assistants.length) return messages;
    return messages.map(stripReasoningDetails);
};

const stripReasoningDetails = (m: Message): Message => {
    if (m.role !== "assistant") return m;
    if (m.reasoning_details === undefined) return m;
    const { reasoning_details: _drop, ...rest } = m;
    return rest;
};

// Standalone helper for /model switching — strip reasoning_details from every
// assistant message in history because signatures / encrypted blobs are
// model-version-bound and don't survive cross-model routing.
export const stripAllReasoningDetails = (messages: readonly Message[]): readonly Message[] => {
    const hasAny = messages.some(
        (m) =>
            m.role === "assistant" &&
            Array.isArray(m.reasoning_details) &&
            m.reasoning_details.length > 0,
    );
    if (!hasAny) return messages;
    return messages.map(stripReasoningDetails);
};

// Round-trip details should be kept in their exact emitted order — caller
// must never reorder, dedupe, or modify the array. This is enforced by
// passing the readonly array through verbatim from the model response.
export const passThroughReasoningDetails = (
    details: readonly ReasoningDetail[],
): readonly ReasoningDetail[] => details;
