import { describe, expect, test } from "bun:test";
import type { Message } from "../types.ts";
import { buildRequestBody } from "./adapt.ts";
import { applyCacheControl, needsExplicitCacheBreakpoints, type TextPart } from "./cacheControl.ts";

const partsOf = (content: unknown): readonly TextPart[] =>
    Array.isArray(content) ? (content as readonly TextPart[]) : [];

const isMarked = (content: unknown): boolean =>
    partsOf(content).some((p) => p.cache_control?.type === "ephemeral");

const markedIndexes = (messages: readonly { content: unknown }[]): number[] =>
    messages.flatMap((m, i) => (isMarked(m.content) ? [i] : []));

describe("needsExplicitCacheBreakpoints", () => {
    test("anthropic models, including tagged variants", () => {
        expect(needsExplicitCacheBreakpoints("anthropic/claude-sonnet-4.6")).toBe(true);
        expect(needsExplicitCacheBreakpoints("anthropic/claude-opus-4.1:thinking")).toBe(true);
    });

    test("providers that cache implicitly are left untouched", () => {
        expect(needsExplicitCacheBreakpoints("deepseek/deepseek-chat")).toBe(false);
        expect(needsExplicitCacheBreakpoints("google/gemini-flash-latest")).toBe(false);
        expect(needsExplicitCacheBreakpoints("openai/gpt-5")).toBe(false);
        // Not a prefix match — an unrelated model that merely mentions the name.
        expect(needsExplicitCacheBreakpoints("someone/anthropic-clone")).toBe(false);
    });
});

describe("applyCacheControl", () => {
    const convo: readonly Message[] = [
        { role: "system", content: "SYSTEM" },
        { role: "user", content: "do a thing" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "c1", type: "function", function: { name: "Read", arguments: "{}" } },
            ],
        },
        { role: "tool", tool_call_id: "c1", content: "FILE BODY" },
    ];

    test("marks the system message and the tail", () => {
        const out = applyCacheControl("anthropic/claude-sonnet-4.6", convo);
        expect(markedIndexes(out)).toEqual([0, 3]);
        expect(partsOf(out[0]?.content)[0]?.text).toBe("SYSTEM");
        expect(partsOf(out[3]?.content)[0]?.text).toBe("FILE BODY");
    });

    test("untouched messages keep their plain string content", () => {
        const out = applyCacheControl("anthropic/claude-sonnet-4.6", convo);
        expect(out[1]?.content).toBe("do a thing");
        expect(out[2]?.content).toBeNull();
        expect(out[2]?.tool_calls).toHaveLength(1);
    });

    test("non-anthropic models are returned verbatim", () => {
        const out = applyCacheControl("deepseek/deepseek-chat", convo);
        expect(out).toBe(convo);
        expect(markedIndexes(out)).toEqual([]);
    });

    test("system message that is also the tail gets exactly one breakpoint", () => {
        const out = applyCacheControl("anthropic/claude-sonnet-4.6", [
            { role: "system", content: "SYSTEM" },
        ]);
        expect(markedIndexes(out)).toEqual([0]);
        expect(partsOf(out[0]?.content)).toHaveLength(1);
    });

    test("skips an assistant tail and marks the last markable message", () => {
        const out = applyCacheControl("anthropic/claude-sonnet-4.6", [
            { role: "system", content: "SYSTEM" },
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
        ]);
        expect(markedIndexes(out)).toEqual([0, 1]);
    });

    test("empty content is never marked", () => {
        const out = applyCacheControl("anthropic/claude-sonnet-4.6", [
            { role: "user", content: "hi" },
            { role: "tool", tool_call_id: "c1", content: "" },
        ]);
        expect(markedIndexes(out)).toEqual([0]);
    });

    test("no markable message — returned verbatim", () => {
        const messages: readonly Message[] = [{ role: "assistant", content: "only me" }];
        expect(applyCacheControl("anthropic/claude-sonnet-4.6", messages)).toBe(messages);
    });

    test("stays within OpenRouter's four-breakpoint limit on a long conversation", () => {
        const long: Message[] = [{ role: "system", content: "SYSTEM" }];
        for (let i = 0; i < 40; i++) {
            long.push({ role: "user", content: `turn ${i}` });
            long.push({ role: "assistant", content: `reply ${i}` });
        }
        expect(markedIndexes(applyCacheControl("anthropic/claude-sonnet-4.6", long)).length).toBe(
            2,
        );
    });
});

describe("buildRequestBody wiring", () => {
    test("anthropic model gets breakpoints in the outgoing body", () => {
        const body = buildRequestBody({
            model: "anthropic/claude-sonnet-4.6",
            messages: [
                { role: "system", content: "SYSTEM" },
                { role: "user", content: "hi" },
            ],
        });
        expect(markedIndexes(body.messages)).toEqual([0, 1]);
    });

    test("non-anthropic model body is unchanged", () => {
        const body = buildRequestBody({
            model: "x-ai/grok-foo",
            messages: [
                { role: "system", content: "SYSTEM" },
                { role: "user", content: "hi" },
            ],
        });
        expect(body.messages.map((m) => m.content)).toEqual(["SYSTEM", "hi"]);
    });
});
