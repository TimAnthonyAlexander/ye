import type { Message, ProviderInput, ToolDefinition } from "../types.ts";
import { isOpus47 } from "./models.ts";

interface AnthropicTextBlock {
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral" };
}

interface AnthropicToolUseBlock {
    type: "tool_use";
    id: string;
    name: string;
    input: unknown;
}

interface AnthropicToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
}

interface AnthropicSystemBlock {
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral" };
}

interface AnthropicTool {
    name: string;
    description: string;
    input_schema: object;
}

// Server-side built-in tool entry. Anthropic types these by `type` and a few
// optional config fields; we forward the object verbatim so callers can pass
// any of `web_search_20250305`, `code_execution_*`, etc., without us having to
// model each variant. Validation is deferred to the API.
type AnthropicBuiltinTool = Readonly<Record<string, unknown>> & { readonly type: string };

interface AnthropicRequestBody {
    model: string;
    messages: AnthropicMessage[];
    max_tokens: number;
    stream: true;
    system?: AnthropicSystemBlock[];
    tools?: (AnthropicTool | AnthropicBuiltinTool)[];
    temperature?: number;
}

const DEFAULT_MAX_TOKENS = 4096;

const safeParseJson = (raw: string): unknown => {
    if (raw.length === 0) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
};

const toAnthropicTool = (t: ToolDefinition): AnthropicTool => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
});

interface SplitResult {
    readonly systemText: string;
    readonly rest: readonly Message[];
}

const splitSystem = (messages: readonly Message[]): SplitResult => {
    const systemParts: string[] = [];
    const rest: Message[] = [];
    for (const m of messages) {
        if (m.role === "system") {
            if (typeof m.content === "string" && m.content.length > 0) {
                systemParts.push(m.content);
            }
            continue;
        }
        rest.push(m);
    }
    return { systemText: systemParts.join("\n\n"), rest };
};

const buildAssistantContent = (msg: Message): AnthropicContentBlock[] => {
    const blocks: AnthropicContentBlock[] = [];
    if (typeof msg.content === "string" && msg.content.length > 0) {
        blocks.push({ type: "text", text: msg.content });
    }
    for (const tc of msg.tool_calls ?? []) {
        blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: safeParseJson(tc.function.arguments),
        });
    }
    return blocks;
};

// Convert Ye's flat OpenAI-style message list into Anthropic's shape:
//   - Adjacent `tool` results merge into a single user message with multiple
//     `tool_result` blocks (Anthropic's required shape).
//   - Assistant messages with tool_calls become content arrays of
//     [text?, tool_use, tool_use, ...].
const convertMessages = (rest: readonly Message[]): AnthropicMessage[] => {
    const out: AnthropicMessage[] = [];
    for (const m of rest) {
        if (m.role === "user") {
            const text = typeof m.content === "string" ? m.content : "";
            const last = out[out.length - 1];
            if (last && last.role === "user" && Array.isArray(last.content)) {
                last.content.push({ type: "text", text });
            } else {
                out.push({ role: "user", content: text });
            }
            continue;
        }
        if (m.role === "assistant") {
            const blocks = buildAssistantContent(m);
            if (blocks.length === 0) continue;
            out.push({ role: "assistant", content: blocks });
            continue;
        }
        if (m.role === "tool" && m.tool_call_id) {
            const block: AnthropicToolResultBlock = {
                type: "tool_result",
                tool_use_id: m.tool_call_id,
                content: typeof m.content === "string" ? m.content : "",
            };
            const last = out[out.length - 1];
            if (last && last.role === "user" && Array.isArray(last.content)) {
                last.content.push(block);
            } else {
                out.push({ role: "user", content: [block] });
            }
            continue;
        }
    }
    return out;
};

// Single cache marker on the system prompt. The whole system body becomes a
// cacheable prefix — typically the largest static segment of the request.
const buildSystem = (text: string): AnthropicSystemBlock[] | undefined => {
    if (text.length === 0) return undefined;
    return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
};

export const buildRequestBody = (input: ProviderInput): AnthropicRequestBody => {
    const { systemText, rest } = splitSystem(input.messages);
    const messages = convertMessages(rest);
    const system = buildSystem(systemText);

    const body: AnthropicRequestBody = {
        model: input.model,
        messages,
        max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
    };

    if (system) body.system = system;

    const userTools: AnthropicTool[] =
        input.tools && input.tools.length > 0 ? input.tools.map(toAnthropicTool) : [];
    const builtin = input.providerOptions?.["builtinTools"];
    const builtinTools: AnthropicBuiltinTool[] = Array.isArray(builtin)
        ? (builtin.filter(
              (t) =>
                  typeof t === "object" &&
                  t !== null &&
                  typeof (t as { type?: unknown }).type === "string",
          ) as AnthropicBuiltinTool[])
        : [];
    if (userTools.length > 0 || builtinTools.length > 0) {
        body.tools = [...userTools, ...builtinTools];
    }

    if (input.temperature !== undefined && !isOpus47(input.model)) {
        body.temperature = input.temperature;
    }

    return body;
};
