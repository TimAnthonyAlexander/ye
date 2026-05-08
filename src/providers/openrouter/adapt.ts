import type { ProviderInput, ToolDefinition } from "../types.ts";

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
    };
}

const DEFAULT_REASONING: OpenRouterReasoningParam = { effort: "high" };

const toOpenRouterTool = (t: ToolDefinition): OpenRouterToolDef => ({
    type: "function",
    function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    },
});

export const buildRequestBody = (input: ProviderInput): OpenRouterRequestBody => {
    const body: OpenRouterRequestBody = {
        model: input.model,
        messages: input.messages,
        stream: input.stream !== false,
    };

    if (input.tools && input.tools.length > 0) {
        body.tools = input.tools.map(toOpenRouterTool);
        body.parallel_tool_calls = false;
    }

    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;

    const opts = input.providerOptions ?? {};

    const reasoning = opts["reasoning"];
    if (reasoning === false) {
        // Explicit opt-out — leave reasoning unset.
    } else if (reasoning && typeof reasoning === "object") {
        body.reasoning = reasoning as OpenRouterReasoningParam;
    } else {
        body.reasoning = DEFAULT_REASONING;
    }

    const order = opts["providerOrder"];
    const allow = opts["allowFallbacks"];
    if (Array.isArray(order) || typeof allow === "boolean") {
        body.provider = {};
        if (Array.isArray(order)) {
            body.provider.order = order.filter((v): v is string => typeof v === "string");
        }
        if (typeof allow === "boolean") {
            body.provider.allow_fallbacks = allow;
        }
    }

    return body;
};
