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
