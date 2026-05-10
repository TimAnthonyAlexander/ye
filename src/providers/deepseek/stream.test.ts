import { describe, expect, test } from "bun:test";
import type { ProviderEvent } from "../types.ts";
import { parseStream } from "./stream.ts";

const sseResponse = (chunks: readonly object[]): Response => {
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
};

const collect = async (gen: AsyncIterable<ProviderEvent>): Promise<readonly ProviderEvent[]> => {
    const out: ProviderEvent[] = [];
    for await (const evt of gen) out.push(evt);
    return out;
};

describe("DeepSeek parseStream", () => {
    test("reasoning_content deltas are accumulated and emitted as reasoning.complete", async () => {
        const res = sseResponse([
            { choices: [{ delta: { reasoning_content: "Let me " } }] },
            { choices: [{ delta: { reasoning_content: "think." } }] },
            { choices: [{ delta: { content: "Answer." } }] },
            { choices: [{ finish_reason: "stop" }] },
        ]);
        const events = await collect(parseStream(res));
        const deltas = events.filter((e) => e.type === "reasoning.delta");
        expect(deltas.length).toBe(2);
        const complete = events.find((e) => e.type === "reasoning.complete");
        if (complete?.type !== "reasoning.complete") throw new Error("missing complete");
        expect(complete.details).toHaveLength(1);
        const [first] = complete.details;
        if (first?.type !== "reasoning.text") throw new Error("expected reasoning.text");
        expect(first.text).toBe("Let me think.");
        expect(first.format).toBe("unknown");
    });

    test("content deltas emit as text.delta", async () => {
        const res = sseResponse([
            { choices: [{ delta: { content: "9.8 " } }] },
            { choices: [{ delta: { content: "is greater." } }] },
            { choices: [{ finish_reason: "stop" }] },
        ]);
        const events = await collect(parseStream(res));
        const textDeltas = events.filter((e) => e.type === "text.delta");
        expect(textDeltas).toHaveLength(2);
    });

    test("tool_calls accumulator emits one tool_call per index on finish", async () => {
        const res = sseResponse([
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_1",
                                    type: "function",
                                    function: { name: "get_date", arguments: "{}" },
                                },
                            ],
                        },
                    },
                ],
            },
            { choices: [{ finish_reason: "tool_calls" }] },
        ]);
        const events = await collect(parseStream(res));
        const tcs = events.filter((e) => e.type === "tool_call");
        expect(tcs).toHaveLength(1);
        if (tcs[0]?.type !== "tool_call") throw new Error("type");
        expect(tcs[0].name).toBe("get_date");
        expect(tcs[0].id).toBe("call_1");
        expect(tcs[0].args).toEqual({});
        const stop = events.find((e) => e.type === "stop");
        if (stop?.type !== "stop") throw new Error("missing stop");
        expect(stop.reason).toBe("tool_use");
    });

    test("usage chunk with empty choices is captured", async () => {
        const res = sseResponse([
            { choices: [{ delta: { content: "ok" } }] },
            { choices: [{ finish_reason: "stop" }] },
            {
                choices: [],
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    prompt_tokens_details: { cached_tokens: 30 },
                },
            },
        ]);
        const events = await collect(parseStream(res));
        const usage = events.find((e) => e.type === "usage");
        if (usage?.type !== "usage") throw new Error("missing usage");
        // billableIn = prompt_tokens - cached = 100 - 30 = 70
        expect(usage.usage.inputTokens).toBe(70);
        expect(usage.usage.outputTokens).toBe(20);
        expect(usage.usage.cacheReadTokens).toBe(30);
    });

    test("no reasoning at all → no reasoning.complete emitted", async () => {
        const res = sseResponse([
            { choices: [{ delta: { content: "hello" } }] },
            { choices: [{ finish_reason: "stop" }] },
        ]);
        const events = await collect(parseStream(res));
        expect(events.find((e) => e.type === "reasoning.complete")).toBeUndefined();
    });

    test("finish_reason length maps to max_tokens", async () => {
        const res = sseResponse([
            { choices: [{ delta: { content: "..." } }] },
            { choices: [{ finish_reason: "length" }] },
        ]);
        const events = await collect(parseStream(res));
        const stop = events.find((e) => e.type === "stop");
        if (stop?.type !== "stop") throw new Error("missing stop");
        expect(stop.reason).toBe("max_tokens");
    });
});
