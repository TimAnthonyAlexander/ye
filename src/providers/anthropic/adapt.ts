import type { Message, ProviderInput, ToolDefinition } from "../types.ts";
import { rejectsSampling } from "./models.ts";

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
    cache_control?: { type: "ephemeral" };
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
    cache_control?: { type: "ephemeral" };
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
    stream: boolean;
    system?: AnthropicSystemBlock[];
    tools?: (AnthropicTool | AnthropicBuiltinTool)[];
    temperature?: number;
}

const DEFAULT_MAX_TOKENS = 4096;

// Anthropic rejects a text block whose text is empty *or* whitespace-only.
// Ye's history legitimately holds both — `Message.content` is `string | null`,
// and several pushes build their text from data — so the adapter is where they
// get dropped, not every producer upstream of it.
const hasText = (content: string | null | undefined): content is string =>
    typeof content === "string" && content.trim().length > 0;

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
    if (hasText(msg.content)) {
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
            if (!hasText(m.content)) continue;
            const last = out[out.length - 1];
            if (last && last.role === "user" && Array.isArray(last.content)) {
                last.content.push({ type: "text", text: m.content });
            } else {
                out.push({ role: "user", content: m.content });
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

// Anthropic reads a request that ends on an assistant message as a prefill to
// continue, which Opus 4.7+ and the whole 5 family reject outright ("This model
// does not support assistant message prefill"). Ye never means that — every
// request it sends opens a fresh agent turn. The only way to land here is an
// empty trailing user message that `convertMessages` dropped, so the marker
// states exactly that instead of inventing a prompt. It also covers a history
// that emptied out completely, since a zero-message request is a 400 too.
//
// Deliberately plain text: dario shares this adapter and deletes tags like
// `<system-reminder>` on the way out, which would empty the block right back
// out again (see providers/dario/reminders.ts).
const CONTINUATION_MARKER =
    "(The turn continues. The message that belongs here carried no content.)";

const ensureUserTail = (messages: AnthropicMessage[]): void => {
    const last = messages[messages.length - 1];
    if (last && last.role !== "assistant") return;
    messages.push({ role: "user", content: CONTINUATION_MARKER });
};

// Single cache marker on the system prompt. The whole system body becomes a
// cacheable prefix — typically the largest static segment of the request.
const buildSystem = (text: string): AnthropicSystemBlock[] | undefined => {
    if (!hasText(text)) return undefined;
    return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
};

const isMarkable = (block: AnthropicContentBlock | undefined): boolean => {
    if (!block) return false;
    if (block.type === "text") return hasText(block.text);
    if (block.type === "tool_result") return block.content.length > 0;
    return false;
};

// Mark the last content block of the last message as a cache breakpoint. Each
// new turn places the breakpoint on its newest block, leaving a cache write
// behind that subsequent turns hit via Anthropic's 20-block lookback. Standard
// agentic pattern — see Anthropic's prompt-caching docs ("Caching messages").
// String content gets converted to a single-block text array so we have a
// concrete object to set cache_control on.
//
// The marker never lands on an empty block: Anthropic answers
// "cache_control cannot be set for empty text blocks" with a non-retryable 400,
// which kills the turn outright. Walk back to the newest block that carries
// something, and mark nothing at all if the message has none.
const markLastMessageCacheable = (messages: AnthropicMessage[]): void => {
    const last = messages[messages.length - 1];
    if (!last) return;
    if (typeof last.content === "string") {
        if (!hasText(last.content)) return;
        last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
        return;
    }
    for (let i = last.content.length - 1; i >= 0; i--) {
        const block = last.content[i];
        if (!isMarkable(block)) continue;
        (block as AnthropicTextBlock | AnthropicToolResultBlock).cache_control = {
            type: "ephemeral",
        };
        return;
    }
};

export const buildRequestBody = (input: ProviderInput): AnthropicRequestBody => {
    const { systemText, rest } = splitSystem(input.messages);
    const messages = convertMessages(rest);
    ensureUserTail(messages);
    markLastMessageCacheable(messages);
    const system = buildSystem(systemText);

    const body: AnthropicRequestBody = {
        model: input.model,
        messages,
        max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: input.stream !== false,
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
        const combined: (AnthropicTool | AnthropicBuiltinTool)[] = [...userTools, ...builtinTools];
        // Cache breakpoint on the last tool — the whole tools array is a
        // stable, sizeable prefix for any session that doesn't change tool
        // surface mid-conversation. Per Anthropic's prompt-caching docs:
        // "Tool definitions can be cached by placing cache_control on the
        // last tool in your tools array."
        const lastTool = combined[combined.length - 1];
        if (lastTool) {
            (lastTool as { cache_control?: { type: "ephemeral" } }).cache_control = {
                type: "ephemeral",
            };
        }
        body.tools = combined;
    }

    if (input.temperature !== undefined && !rejectsSampling(input.model)) {
        body.temperature = input.temperature;
    }

    return body;
};
