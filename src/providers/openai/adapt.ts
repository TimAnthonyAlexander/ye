import { isSmallModel } from "../modelTier.ts";
import type { ProviderInput, ToolDefinition } from "../types.ts";

export type OpenAIInputItem =
    | { type: "message"; role: string; content: string | OpenAIContentPart[] }
    | { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
    | { type: "reasoning"; id: string; encrypted_content?: string; summary?: OpenAIContentPart[] }
    | { type: "function_call_output"; call_id: string; output: string };

export type OpenAIContentPart = { type: "output_text"; text: string };

export interface OpenAIRequestBody {
    model: string;
    input: OpenAIInputItem[] | string;
    instructions?: string;
    stream?: boolean;
    max_output_tokens?: number;
    temperature?: number;
    parallel_tool_calls?: boolean;
    tool_choice?: string | object;
    tools?: OpenAITool[];
    reasoning?: { effort: string; summary?: string };
    store?: boolean;
    include?: string[];
    prompt_cache_key?: string;
    prompt_cache_retention?: string;
}

// Models that accept `prompt_cache_retention: "24h"`. Setting it on older
// models (gpt-5, gpt-4.1, codex-mini-latest) returns 400 from the API.
// Per OpenAI's prompt-caching docs: extended retention shipped with the
// GPT-5.1 family — gpt-5.1, gpt-5.1-codex, gpt-5.1-codex-mini, plus all of
// gpt-5.2/5.3/5.4/5.5 (where gpt-5.5+ actually REQUIRES it).
const EXTENDED_CACHE_RETENTION_RE = /^gpt-5\.[1-9]/;

export interface OpenAITool {
    type: "function";
    name: string;
    description: string;
    strict?: boolean;
    parameters: object;
}

const makeStrict = (schema: any): any => {
    if (!schema || typeof schema !== "object") return schema;

    if (schema.type === "object") {
        const properties = schema.properties ?? {};
        const required = Object.keys(properties);

        const newProps: any = {};
        for (const [key, value] of Object.entries(properties)) {
            newProps[key] = makeStrict(value);
        }

        return {
            ...schema,
            properties: newProps,
            required,
            additionalProperties: false,
        };
    }

    if (schema.type === "array" && schema.items) {
        return {
            ...schema,
            items: makeStrict(schema.items),
        };
    }

    return schema;
};

const toOpenAITool = (t: ToolDefinition): OpenAITool => ({
    type: "function",
    name: t.name,
    description: t.description,
    strict: true,
    parameters: makeStrict(t.parameters),
});

export const buildRequestBody = (input: ProviderInput): OpenAIRequestBody => {
    const messages: OpenAIInputItem[] = [];
    let instructions: string | undefined;

    for (const msg of input.messages) {
        if (msg.role === "system") {
            // Responses API uses instructions param for system-level context.
            // If multiple system messages exist, we concatenate them.
            instructions = instructions ? `${instructions}\n\n${msg.content}` : (msg.content ?? "");
            continue;
        }

        if (msg.role === "user") {
            messages.push({
                type: "message",
                role: "user",
                content: msg.content ?? "",
            });
        } else if (msg.role === "assistant") {
            if (msg.tool_calls) {
                // OpenAI Responses API uses function_call items in output/input.
                for (const tc of msg.tool_calls) {
                    messages.push({
                        type: "function_call",
                        id: tc.id.startsWith("call_")
                            ? tc.id.replace("call_", "fc_")
                            : `fc_${tc.id}`,
                        call_id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                    });
                }
            } else {
                messages.push({
                    type: "message",
                    role: "assistant",
                    content: msg.content ?? "",
                });
            }
        } else if (msg.role === "tool") {
            messages.push({
                type: "function_call_output",
                call_id: msg.tool_call_id ?? "",
                output: msg.content ?? "",
            });
        }
    }

    const body: OpenAIRequestBody = {
        model: input.model,
        input: messages,
        stream: input.stream !== false,
        store: false, // Default to no server-side storage for Ye
        include: ["reasoning.encrypted_content"],
    };

    if (instructions) body.instructions = instructions;

    if (input.tools && input.tools.length > 0) {
        body.tools = input.tools.map(toOpenAITool);
        body.parallel_tool_calls = true;
    }

    if (input.maxTokens !== undefined) body.max_output_tokens = input.maxTokens;

    // Pin requests with the same prefix to the same cache shard. Without this,
    // OpenAI's load balancer routes successive requests to different shards
    // and the first 2-3 calls of every session miss the cache despite an
    // identical prefix. See OpenAI's "Prompt Caching 201" cookbook.
    if (input.cacheKey) body.prompt_cache_key = input.cacheKey;

    // Extended retention pushes prefix TTL from the default 5–10 minutes
    // (in_memory) to 24 hours, so successive sessions on the same project
    // keep hitting the cache instead of each cold-starting it. gpt-5.5+
    // actually require this — passing the default in_memory would 400.
    // gpt-5.0 and older 400 on this param entirely, so it's gated on the
    // model family.
    if (EXTENDED_CACHE_RETENTION_RE.test(input.model)) {
        body.prompt_cache_retention = "24h";
    }

    // GPT-5 reasoning models reject temperature if it's not actually used by the model family.
    // GPT-4.1 series still uses it.
    if (input.temperature !== undefined && !input.model.startsWith("gpt-5")) {
        body.temperature = input.temperature;
    }

    const opts = input.providerOptions ?? {};
    const reasoningEffort = opts["reasoningEffort"];
    if (typeof reasoningEffort === "string") {
        body.reasoning = { effort: reasoningEffort, summary: "auto" };
    } else if (input.model.startsWith("gpt-5")) {
        // Default reasoning for GPT-5 if not specified. "mini"/"nano" variants
        // get "low" — small reasoning models over-plan and loop at medium/high
        // effort, especially under tool-heavy work. Note: codex-mini does NOT
        // support "minimal" (API rejects it with "supported: low, medium,
        // high"), so "low" is the floor for that family. Full GPT-5 models
        // keep "medium" as a balanced default.
        const effort = isSmallModel(input.model) ? "low" : "medium";
        body.reasoning = { effort, summary: "auto" };
    }

    return body;
};
