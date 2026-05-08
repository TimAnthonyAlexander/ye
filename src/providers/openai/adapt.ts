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
}

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
                        id: tc.id.startsWith("call_") ? tc.id.replace("call_", "fc_") : `fc_${tc.id}`,
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
        // Default reasoning for GPT-5 if not specified.
        body.reasoning = { effort: "medium", summary: "auto" };
    }

    return body;
};
