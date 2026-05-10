import type { ProviderInput, ToolDefinition } from "../types.ts";
import { applyInputPolicy, getReasoningPolicy } from "./reasoningPolicy.ts";

interface OpenRouterToolDef {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: object;
    };
}

interface OpenRouterReasoningParam {
    effort?: string;
    max_tokens?: number;
    enabled?: boolean;
    exclude?: boolean;
}

interface OpenRouterRequestBody {
    model: string;
    messages: ProviderInput["messages"];
    stream: boolean;
    tools?: OpenRouterToolDef[];
    tool_choice?: "auto" | "none";
    parallel_tool_calls?: boolean;
    temperature?: number;
    max_tokens?: number;
    reasoning?: OpenRouterReasoningParam;
    provider?: {
        order?: string[];
        allow_fallbacks?: boolean;
        sort?: "price" | "throughput" | "latency";
    };
}

const toOpenRouterTool = (t: ToolDefinition): OpenRouterToolDef => ({
    type: "function",
    function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    },
});

// Build the reasoning request param from the per-model policy. If the user
// has passed an explicit object via providerOptions.reasoning, honor it as-is.
// Explicit `false` is honored only when the model permits disabling — otherwise
// the field is left unset and the upstream applies its default (Gemini 3 Pro
// can't disable thinking, V4 Pro thinks by default).
const buildReasoningParam = (
    modelId: string,
    explicit: unknown,
): OpenRouterReasoningParam | undefined => {
    if (explicit && typeof explicit === "object") {
        return explicit as OpenRouterReasoningParam;
    }

    const { default: defaultEffort, canDisable } = getReasoningPolicy(modelId).effort;

    if (explicit === false) {
        if (canDisable) return undefined;
        // Fall through — model can't be disabled, apply default effort.
    }

    if (defaultEffort === null) return undefined;
    return { effort: defaultEffort };
};

export const buildRequestBody = (input: ProviderInput): OpenRouterRequestBody => {
    const body: OpenRouterRequestBody = {
        model: input.model,
        messages: applyInputPolicy(input.model, input.messages),
        stream: input.stream !== false,
    };

    if (input.tools && input.tools.length > 0) {
        body.tools = input.tools.map(toOpenRouterTool);
        body.parallel_tool_calls = false;
    }

    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;

    const opts = input.providerOptions ?? {};

    const reasoningParam = buildReasoningParam(input.model, opts["reasoning"]);
    if (reasoningParam !== undefined) body.reasoning = reasoningParam;

    const order = opts["providerOrder"];
    const allow = opts["allowFallbacks"];
    const sort = opts["providerSort"];
    const sortValid = sort === "price" || sort === "throughput" || sort === "latency";
    if (Array.isArray(order) || typeof allow === "boolean" || sortValid) {
        body.provider = {};
        if (Array.isArray(order)) {
            body.provider.order = order.filter((v): v is string => typeof v === "string");
        }
        if (typeof allow === "boolean") {
            body.provider.allow_fallbacks = allow;
        }
        if (sortValid) {
            body.provider.sort = sort;
        }
    }

    return body;
};
