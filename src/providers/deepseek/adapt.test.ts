import { describe, expect, test } from "bun:test";
import type { Message, ProviderInput, ReasoningDetail } from "../types.ts";
import { _internal, buildRequestBody } from "./adapt.ts";

const { toWireMessages, lastUserIndex } = _internal;

const detail = (text: string): ReasoningDetail => ({
    type: "reasoning.text",
    text,
    format: "unknown",
    index: 0,
});

const baseInput = (messages: readonly Message[]): ProviderInput => ({
    model: "deepseek-v4-pro",
    messages,
    stream: true,
});

describe("toWireMessages — tool-loop window for reasoning_content", () => {
    test("active turn (assistant after last user) keeps reasoning_content", () => {
        const msgs: readonly Message[] = [
            { role: "user", content: "hello" },
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    { id: "t1", type: "function", function: { name: "Read", arguments: "{}" } },
                ],
                reasoning_details: [detail("I should read the file")],
            },
            { role: "tool", tool_call_id: "t1", content: "file contents" },
        ];
        const wire = toWireMessages(msgs);
        const assistantWire = wire[1] as { reasoning_content?: string };
        expect(assistantWire.reasoning_content).toBe("I should read the file");
    });

    test("closed prior turn (assistant before last user) drops reasoning_content", () => {
        const msgs: readonly Message[] = [
            { role: "user", content: "first" },
            {
                role: "assistant",
                content: "first answer",
                reasoning_details: [detail("thinking about first")],
            },
            { role: "user", content: "second" },
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    { id: "t1", type: "function", function: { name: "Read", arguments: "{}" } },
                ],
                reasoning_details: [detail("thinking about second")],
            },
        ];
        const wire = toWireMessages(msgs);
        const closedPrior = wire[1] as { reasoning_content?: string };
        const activeTurn = wire[3] as { reasoning_content?: string };
        expect(closedPrior.reasoning_content).toBeUndefined();
        expect(activeTurn.reasoning_content).toBe("thinking about second");
    });

    test("no reasoning_details on assistant → no reasoning_content on wire", () => {
        const msgs: readonly Message[] = [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
        ];
        const wire = toWireMessages(msgs);
        const w = wire[1] as { reasoning_content?: string };
        expect(w.reasoning_content).toBeUndefined();
    });

    test("multi-block reasoning concatenates in emission order", () => {
        const msgs: readonly Message[] = [
            { role: "user", content: "hi" },
            {
                role: "assistant",
                content: "hello",
                reasoning_details: [detail("step A "), detail("step B")],
            },
        ];
        const wire = toWireMessages(msgs);
        const w = wire[1] as { reasoning_content?: string };
        expect(w.reasoning_content).toBe("step A step B");
    });

    test("non-text reasoning blocks are ignored at flatten time", () => {
        const msgs: readonly Message[] = [
            { role: "user", content: "hi" },
            {
                role: "assistant",
                content: "ok",
                reasoning_details: [
                    detail("readable text"),
                    { type: "reasoning.encrypted", data: "blob", index: 1 },
                ],
            },
        ];
        const wire = toWireMessages(msgs);
        const w = wire[1] as { reasoning_content?: string };
        expect(w.reasoning_content).toBe("readable text");
    });
});

describe("lastUserIndex", () => {
    test("returns the index of the most recent user message", () => {
        const msgs: readonly Message[] = [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
            { role: "user", content: "c" },
        ];
        expect(lastUserIndex(msgs)).toBe(2);
    });

    test("returns -1 when no user message exists", () => {
        const msgs: readonly Message[] = [{ role: "assistant", content: "b" }];
        expect(lastUserIndex(msgs)).toBe(-1);
    });
});

describe("buildRequestBody", () => {
    test("emits thinking enabled with default effort high", () => {
        const body = buildRequestBody(baseInput([{ role: "user", content: "hi" }]));
        expect(body.thinking).toEqual({ type: "enabled" });
        expect(body.reasoning_effort).toBe("high");
    });

    test("explicit max effort honored", () => {
        const body = buildRequestBody({
            ...baseInput([{ role: "user", content: "hi" }]),
            providerOptions: { reasoning: { effort: "max" } },
        });
        expect(body.reasoning_effort).toBe("max");
    });

    test("low/medium effort hints get clamped to high (DeepSeek's behavior)", () => {
        const body = buildRequestBody({
            ...baseInput([{ role: "user", content: "hi" }]),
            providerOptions: { reasoning: { effort: "low" } },
        });
        expect(body.reasoning_effort).toBe("high");
    });

    test("reasoning=false disables thinking", () => {
        const body = buildRequestBody({
            ...baseInput([{ role: "user", content: "hi" }]),
            providerOptions: { reasoning: false },
        });
        expect(body.thinking).toEqual({ type: "disabled" });
        expect(body.reasoning_effort).toBeUndefined();
    });

    test("stream_options.include_usage set when streaming", () => {
        const body = buildRequestBody(baseInput([{ role: "user", content: "hi" }]));
        expect(body.stream_options).toEqual({ include_usage: true });
    });

    test("stream_options absent when stream=false", () => {
        const body = buildRequestBody({
            ...baseInput([{ role: "user", content: "hi" }]),
            stream: false,
        });
        expect(body.stream_options).toBeUndefined();
    });

    test("tools array mapped, parallel_tool_calls disabled", () => {
        const body = buildRequestBody({
            ...baseInput([{ role: "user", content: "hi" }]),
            tools: [{ name: "Read", description: "read", parameters: { type: "object" } }],
        });
        expect(body.tools).toHaveLength(1);
        expect(body.tools?.[0]).toEqual({
            type: "function",
            function: { name: "Read", description: "read", parameters: { type: "object" } },
        });
        expect(body.parallel_tool_calls).toBe(false);
    });
});
