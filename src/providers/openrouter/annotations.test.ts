import { describe, expect, test } from "bun:test";
import type { ProviderEvent } from "../types.ts";
import { parseBatch, parseStream } from "./stream.ts";

const sseResponse = (chunks: readonly object[]): Response => {
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
};

const jsonResponse = (body: object): Response =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });

const collect = async (gen: AsyncIterable<ProviderEvent>): Promise<readonly ProviderEvent[]> => {
    const out: ProviderEvent[] = [];
    for await (const evt of gen) out.push(evt);
    return out;
};

describe("openrouter annotations extraction", () => {
    test("parseBatch emits citations event from message.annotations[].url_citation", async () => {
        const res = jsonResponse({
            choices: [
                {
                    message: {
                        content: "Lairner is a language-learning app.",
                        annotations: [
                            {
                                type: "url_citation",
                                url_citation: {
                                    url: "https://lairner.app",
                                    title: "lairner",
                                    content: "snippet",
                                    start_index: 0,
                                    end_index: 35,
                                },
                            },
                            {
                                type: "url_citation",
                                url_citation: {
                                    url: "https://news.ycombinator.com/item?id=39371728",
                                },
                            },
                        ],
                    },
                    finish_reason: "stop",
                },
            ],
        });

        const events = await collect(parseBatch(res));
        const cit = events.find((e) => e.type === "citations");
        if (cit?.type !== "citations") throw new Error("missing citations");
        expect(cit.citations).toHaveLength(2);
        expect(cit.citations[0]?.url).toBe("https://lairner.app");
        expect(cit.citations[0]?.title).toBe("lairner");
        expect(cit.citations[0]?.startIndex).toBe(0);
        expect(cit.citations[1]?.url).toBe("https://news.ycombinator.com/item?id=39371728");
    });

    test("parseBatch ignores non-url_citation annotation types and invalid urls", async () => {
        const res = jsonResponse({
            choices: [
                {
                    message: {
                        content: "x",
                        annotations: [
                            { type: "weird_type", url_citation: { url: "https://a.example" } },
                            { type: "url_citation" }, // no url_citation object
                            { type: "url_citation", url_citation: { url: "" } }, // empty url
                            { type: "url_citation", url_citation: { url: "https://ok.example" } },
                        ],
                    },
                    finish_reason: "stop",
                },
            ],
        });
        const events = await collect(parseBatch(res));
        const cit = events.find((e) => e.type === "citations");
        if (cit?.type !== "citations") throw new Error("missing citations");
        expect(cit.citations).toEqual([{ url: "https://ok.example" }]);
    });

    test("parseStream accumulates annotations across deltas and dedupes by url", async () => {
        const res = sseResponse([
            {
                choices: [
                    {
                        delta: {
                            content: "Hello ",
                            annotations: [
                                {
                                    type: "url_citation",
                                    url_citation: { url: "https://a.example", title: "A short" },
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
                            content: "world",
                            annotations: [
                                {
                                    type: "url_citation",
                                    url_citation: {
                                        url: "https://a.example",
                                        title: "A longer title",
                                        content: "snippet",
                                    },
                                },
                                {
                                    type: "url_citation",
                                    url_citation: { url: "https://b.example" },
                                },
                            ],
                        },
                    },
                ],
            },
            { choices: [{ finish_reason: "stop" }] },
        ]);
        const events = await collect(parseStream(res));
        const cit = events.find((e) => e.type === "citations");
        if (cit?.type !== "citations") throw new Error("missing citations");
        expect(cit.citations).toHaveLength(2);
        const a = cit.citations.find((c) => c.url === "https://a.example");
        const b = cit.citations.find((c) => c.url === "https://b.example");
        expect(a?.title).toBe("A longer title");
        expect(a?.content).toBe("snippet");
        expect(b?.url).toBe("https://b.example");
    });

    test("parseStream emits no citations event when none present", async () => {
        const res = sseResponse([
            { choices: [{ delta: { content: "no annotations here" } }] },
            { choices: [{ finish_reason: "stop" }] },
        ]);
        const events = await collect(parseStream(res));
        expect(events.find((e) => e.type === "citations")).toBeUndefined();
    });
});
