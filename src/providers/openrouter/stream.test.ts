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

describe("parseStream reasoning_details accumulation", () => {
    test("emits one reasoning.complete with merged text in original order", async () => {
        const res = sseResponse([
            {
                choices: [
                    {
                        delta: {
                            reasoning_details: [
                                {
                                    type: "reasoning.text",
                                    text: "Let me ",
                                    format: "anthropic-claude-v1",
                                    index: 0,
                                },
                            ],
                        },
                    },
                ],
            },
            {
                choices: [
                    {
                        delta: {
                            reasoning_details: [
                                {
                                    type: "reasoning.text",
                                    text: "think about this.",
                                    format: "anthropic-claude-v1",
                                    index: 0,
                                    signature: "sig-abc",
                                },
                            ],
                        },
                    },
                ],
            },
            { choices: [{ delta: { content: "Answer." } }] },
            { choices: [{ finish_reason: "stop" }] },
        ]);

        const events = await collect(parseStream(res));
        const complete = events.find((e) => e.type === "reasoning.complete");
        expect(complete).toBeDefined();
        if (complete?.type !== "reasoning.complete") throw new Error("type guard");
        expect(complete.details).toHaveLength(1);
        const [first] = complete.details;
        if (first?.type !== "reasoning.text") throw new Error("expected reasoning.text");
        expect(first.text).toBe("Let me think about this.");
        expect(first.signature).toBe("sig-abc");
        expect(first.format).toBe("anthropic-claude-v1");
        expect(first.index).toBe(0);
    });

    test("preserves emission order across multiple indices", async () => {
        const res = sseResponse([
            {
                choices: [
                    {
                        delta: {
                            reasoning_details: [{ type: "reasoning.text", text: "A", index: 0 }],
                        },
                    },
                ],
            },
            {
                choices: [
                    {
                        delta: {
                            reasoning_details: [{ type: "reasoning.text", text: "B", index: 1 }],
                        },
                    },
                ],
            },
            { choices: [{ finish_reason: "stop" }] },
        ]);

        const events = await collect(parseStream(res));
        const complete = events.find((e) => e.type === "reasoning.complete");
        if (complete?.type !== "reasoning.complete") throw new Error("missing complete");
        expect(complete.details.map((d) => (d.type === "reasoning.text" ? d.text : ""))).toEqual([
            "A",
            "B",
        ]);
    });

    test("preserves encrypted detail with data field", async () => {
        const res = sseResponse([
            {
                choices: [
                    {
                        delta: {
                            reasoning_details: [
                                {
                                    type: "reasoning.encrypted",
                                    data: "enc-blob-xyz",
                                    format: "openai-responses-v1",
                                    id: "rs_42",
                                    index: 0,
                                },
                            ],
                        },
                    },
                ],
            },
            { choices: [{ finish_reason: "stop" }] },
        ]);

        const events = await collect(parseStream(res));
        const complete = events.find((e) => e.type === "reasoning.complete");
        if (complete?.type !== "reasoning.complete") throw new Error("missing complete");
        const [first] = complete.details;
        if (first?.type !== "reasoning.encrypted") throw new Error("expected encrypted");
        expect(first.data).toBe("enc-blob-xyz");
        expect(first.id).toBe("rs_42");
        expect(first.format).toBe("openai-responses-v1");
    });

    test("no reasoning_details in stream → no reasoning.complete emitted", async () => {
        const res = sseResponse([
            { choices: [{ delta: { content: "Just text." } }] },
            { choices: [{ finish_reason: "stop" }] },
        ]);

        const events = await collect(parseStream(res));
        expect(events.find((e) => e.type === "reasoning.complete")).toBeUndefined();
    });

    test("reasoning.delta text stream still works for UI", async () => {
        const res = sseResponse([
            {
                choices: [
                    {
                        delta: {
                            reasoning_details: [
                                { type: "reasoning.text", text: "thinking ", index: 0 },
                            ],
                        },
                    },
                ],
            },
            { choices: [{ finish_reason: "stop" }] },
        ]);

        const events = await collect(parseStream(res));
        const deltas = events.filter((e) => e.type === "reasoning.delta");
        expect(deltas.length).toBeGreaterThan(0);
    });

    test("upstream provider name from chunk.provider is attached to usage event", async () => {
        const res = sseResponse([
            { provider: "DeepInfra", choices: [{ delta: { content: "hi" } }] },
            { choices: [{ finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 30, completion_tokens: 10 } },
        ]);

        const events = await collect(parseStream(res));
        const usage = events.find((e) => e.type === "usage");
        if (usage?.type !== "usage") throw new Error("missing usage");
        expect(usage.usage.upstream).toBe("DeepInfra");
    });

    test("no upstream → usage event has no upstream field", async () => {
        const res = sseResponse([
            { choices: [{ delta: { content: "hi" } }] },
            { choices: [{ finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 30, completion_tokens: 10 } },
        ]);

        const events = await collect(parseStream(res));
        const usage = events.find((e) => e.type === "usage");
        if (usage?.type !== "usage") throw new Error("missing usage");
        expect(usage.usage.upstream).toBeUndefined();
    });
});
