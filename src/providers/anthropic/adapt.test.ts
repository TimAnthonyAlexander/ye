import { describe, expect, test } from "bun:test";
import type { Message, ProviderInput } from "../types.ts";
import { buildRequestBody } from "./adapt.ts";

const baseInput = (
    messages: readonly Message[],
    overrides: Partial<ProviderInput> = {},
): ProviderInput => ({
    model: "claude-sonnet-4-6",
    messages,
    stream: true,
    ...overrides,
});

describe("buildRequestBody — cache_control breakpoints", () => {
    test("system prompt carries cache_control", () => {
        const body = buildRequestBody(
            baseInput([
                { role: "system", content: "you are an agent" },
                { role: "user", content: "hi" },
            ]),
        );
        expect(body.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
    });

    test("last tool in tools array carries cache_control; earlier tools do not", () => {
        const body = buildRequestBody(
            baseInput([{ role: "user", content: "hi" }], {
                tools: [
                    { name: "Read", description: "read", parameters: { type: "object" } },
                    { name: "Edit", description: "edit", parameters: { type: "object" } },
                    { name: "Write", description: "write", parameters: { type: "object" } },
                ],
            }),
        );
        expect(body.tools).toHaveLength(3);
        const tools = body.tools as Array<{ cache_control?: { type: "ephemeral" } }>;
        expect(tools[0]?.cache_control).toBeUndefined();
        expect(tools[1]?.cache_control).toBeUndefined();
        expect(tools[2]?.cache_control).toEqual({ type: "ephemeral" });
    });

    test("no cache_control set when tools array is absent", () => {
        const body = buildRequestBody(baseInput([{ role: "user", content: "hi" }]));
        expect(body.tools).toBeUndefined();
    });

    test("last message (string content) is converted to a text block with cache_control", () => {
        const body = buildRequestBody(baseInput([{ role: "user", content: "hi" }]));
        expect(body.messages).toHaveLength(1);
        const lastMsg = body.messages[0];
        expect(Array.isArray(lastMsg?.content)).toBe(true);
        const content = lastMsg?.content as Array<{
            type: string;
            text?: string;
            cache_control?: { type: "ephemeral" };
        }>;
        expect(content[0]?.type).toBe("text");
        expect(content[0]?.text).toBe("hi");
        expect(content[0]?.cache_control).toEqual({ type: "ephemeral" });
    });

    test("multi-turn: cache_control lands on the last block of the last message only", () => {
        const body = buildRequestBody(
            baseInput([
                { role: "user", content: "first" },
                { role: "assistant", content: "answer" },
                { role: "user", content: "second" },
            ]),
        );
        // user / assistant / user
        expect(body.messages).toHaveLength(3);
        const first = body.messages[0];
        const last = body.messages[2];
        // first user is now a string (untouched)
        expect(typeof first?.content).toBe("string");
        // last user converted to array with cache_control on its only block
        const lastContent = last?.content as Array<{ cache_control?: { type: "ephemeral" } }>;
        expect(lastContent[0]?.cache_control).toEqual({ type: "ephemeral" });
    });

    test("tool_result loop: cache_control lands on the last tool_result block", () => {
        const body = buildRequestBody(
            baseInput([
                { role: "user", content: "do it" },
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        { id: "t1", type: "function", function: { name: "Read", arguments: "{}" } },
                        {
                            id: "t2",
                            type: "function",
                            function: { name: "Glob", arguments: "{}" },
                        },
                    ],
                },
                { role: "tool", tool_call_id: "t1", content: "file contents" },
                { role: "tool", tool_call_id: "t2", content: "matches" },
            ]),
        );
        // user "do it" / assistant tool_uses / user(merged tool_results)
        const last = body.messages[body.messages.length - 1];
        const blocks = last?.content as Array<{
            type: string;
            tool_use_id?: string;
            cache_control?: { type: "ephemeral" };
        }>;
        expect(blocks).toHaveLength(2);
        expect(blocks[0]?.cache_control).toBeUndefined();
        expect(blocks[1]?.cache_control).toEqual({ type: "ephemeral" });
        expect(blocks[1]?.tool_use_id).toBe("t2");
    });

    test("breakpoint count stays within Anthropic's max of 4 (system + last tool + last block)", () => {
        const body = buildRequestBody(
            baseInput(
                [
                    { role: "system", content: "sys" },
                    { role: "user", content: "hi" },
                ],
                {
                    tools: [
                        { name: "Read", description: "read", parameters: { type: "object" } },
                        { name: "Edit", description: "edit", parameters: { type: "object" } },
                    ],
                },
            ),
        );
        let count = 0;
        for (const blk of body.system ?? []) {
            if (blk.cache_control) count += 1;
        }
        for (const t of body.tools ?? []) {
            if ((t as { cache_control?: unknown }).cache_control) count += 1;
        }
        for (const m of body.messages ?? []) {
            if (Array.isArray(m.content)) {
                for (const blk of m.content) {
                    if (blk.type === "text" || blk.type === "tool_result") {
                        if ((blk as { cache_control?: unknown }).cache_control) count += 1;
                    }
                }
            }
        }
        expect(count).toBe(3);
        expect(count).toBeLessThanOrEqual(4);
    });
});

// Anthropic answers a cache_control on an empty text block with a
// non-retryable 400 — "messages.N.content.0.text: cache_control cannot be set
// for empty text blocks" — which ends the turn outright. Verified against the
// live API: whitespace-only counts as empty, and the block only has to be the
// one carrying the marker.
describe("buildRequestBody — empty text blocks", () => {
    const markedBlocks = (body: ReturnType<typeof buildRequestBody>) =>
        body.messages.flatMap((m) =>
            Array.isArray(m.content)
                ? m.content.filter((b) => (b as { cache_control?: unknown }).cache_control)
                : [],
        );

    test("an empty trailing user message never carries a cache breakpoint", () => {
        const body = buildRequestBody(
            baseInput([
                { role: "user", content: "first" },
                { role: "assistant", content: "answer" },
                { role: "user", content: "" },
            ]),
        );
        for (const block of markedBlocks(body)) {
            expect((block as { text?: string }).text?.trim().length ?? 0).toBeGreaterThan(0);
        }
    });

    test("a whitespace-only trailing user message never carries a cache breakpoint", () => {
        const body = buildRequestBody(
            baseInput([
                { role: "user", content: "first" },
                { role: "assistant", content: "answer" },
                { role: "user", content: "   \n  " },
            ]),
        );
        for (const block of markedBlocks(body)) {
            expect((block as { text?: string }).text?.trim().length ?? 0).toBeGreaterThan(0);
        }
    });

    test("a null-content user message never becomes an empty text block", () => {
        const body = buildRequestBody(
            baseInput([
                { role: "user", content: "first" },
                { role: "assistant", content: "answer" },
                { role: "user", content: null },
            ]),
        );
        for (const m of body.messages) {
            if (!Array.isArray(m.content)) continue;
            for (const block of m.content) {
                if (block.type !== "text") continue;
                expect(block.text.trim().length).toBeGreaterThan(0);
            }
        }
    });

    test("empty user messages are dropped, not sent as empty blocks", () => {
        const body = buildRequestBody(
            baseInput([
                { role: "user", content: "" },
                { role: "user", content: "real question" },
            ]),
        );
        expect(body.messages).toHaveLength(1);
        const content = body.messages[0]?.content as Array<{ text?: string }>;
        expect(content[0]?.text).toBe("real question");
    });

    test("the breakpoint walks back past an empty trailing block to the last real one", () => {
        const body = buildRequestBody(
            baseInput([
                { role: "assistant", content: null, tool_calls: [] },
                { role: "tool", tool_call_id: "t1", content: "tool output" },
                { role: "user", content: "" },
            ]),
        );
        const marked = markedBlocks(body);
        expect(marked).toHaveLength(1);
        expect(marked[0]?.type).toBe("tool_result");
    });

    // Dropping the tail is only half the job: Anthropic rejects a request that
    // ends on an assistant message ("does not support assistant message
    // prefill") and a request with no messages at all.
    test("dropping an empty tail never leaves the request ending on an assistant message", () => {
        const body = buildRequestBody(
            baseInput([
                { role: "user", content: "do the thing" },
                { role: "assistant", content: "on it" },
                { role: "user", content: "" },
            ]),
        );
        expect(body.messages[body.messages.length - 1]?.role).toBe("user");
        expect(markedBlocks(body)).toHaveLength(1);
    });

    test("a lone empty user message still produces a valid single-message request", () => {
        const body = buildRequestBody(baseInput([{ role: "user", content: "" }]));
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0]?.role).toBe("user");
        const content = body.messages[0]?.content as Array<{ text?: string }>;
        expect(content[0]?.text?.trim().length ?? 0).toBeGreaterThan(0);
    });

    test("an ordinary user tail is left alone — no marker is appended", () => {
        const body = buildRequestBody(
            baseInput([
                { role: "user", content: "first" },
                { role: "assistant", content: "answer" },
                { role: "user", content: "second" },
            ]),
        );
        expect(body.messages).toHaveLength(3);
        const content = body.messages[2]?.content as Array<{ text?: string }>;
        expect(content[0]?.text).toBe("second");
    });

    test("a whitespace-only system prompt is not sent as a marked system block", () => {
        const body = buildRequestBody(
            baseInput([
                { role: "system", content: "  " },
                { role: "user", content: "hi" },
            ]),
        );
        expect(body.system).toBeUndefined();
    });
});

describe("buildRequestBody — temperature stripping", () => {
    test("does not include temperature for Claude Opus 4.7", () => {
        const body = buildRequestBody(
            baseInput([{ role: "user", content: "hi" }], {
                model: "claude-opus-4-7",
                temperature: 0.7,
            }),
        );
        expect(body.temperature).toBeUndefined();
    });

    test("does not include temperature for Claude Opus 4.8", () => {
        const body = buildRequestBody(
            baseInput([{ role: "user", content: "hi" }], {
                model: "claude-opus-4-8",
                temperature: 0.7,
            }),
        );
        expect(body.temperature).toBeUndefined();
    });

    test("includes temperature for Sonnet 4.6", () => {
        const body = buildRequestBody(
            baseInput([{ role: "user", content: "hi" }], {
                model: "claude-sonnet-4-6",
                temperature: 0.7,
            }),
        );
        expect(body.temperature).toBe(0.7);
    });
});
