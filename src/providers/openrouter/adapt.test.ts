import { describe, expect, test } from "bun:test";
import type { ProviderInput } from "../types.ts";
import { buildRequestBody } from "./adapt.ts";

const baseInput: ProviderInput = {
    model: "x-ai/grok-foo",
    messages: [{ role: "user", content: "hi" }],
};

describe("openrouter adapt — builtinTools passthrough", () => {
    test("appends builtin tools verbatim alongside function tools", () => {
        const body = buildRequestBody({
            ...baseInput,
            tools: [
                {
                    name: "Read",
                    description: "read a file",
                    parameters: { type: "object" },
                },
            ],
            providerOptions: {
                builtinTools: [
                    { type: "openrouter:web_search", max_results: 7 },
                    { type: "openrouter:web_fetch" },
                ],
            },
        });

        expect(body.tools).toHaveLength(3);
        const first = body.tools?.[0];
        expect(first?.type).toBe("function");
        expect(body.tools?.[1]).toEqual({ type: "openrouter:web_search", max_results: 7 });
        expect(body.tools?.[2]).toEqual({ type: "openrouter:web_fetch" });
        expect(body.parallel_tool_calls).toBe(false);
    });

    test("builtin tools alone — no function tools — still set body.tools", () => {
        const body = buildRequestBody({
            ...baseInput,
            providerOptions: {
                builtinTools: [{ type: "openrouter:web_search" }],
            },
        });
        expect(body.tools).toEqual([{ type: "openrouter:web_search" }]);
        expect(body.parallel_tool_calls).toBe(false);
    });

    test("ignores non-object entries and entries missing string type", () => {
        const body = buildRequestBody({
            ...baseInput,
            providerOptions: {
                builtinTools: [
                    { type: "openrouter:web_search" },
                    "not-an-object",
                    { notType: "x" },
                    null,
                ],
            },
        });
        expect(body.tools).toEqual([{ type: "openrouter:web_search" }]);
    });

    test("no builtinTools and no tools — body.tools is undefined", () => {
        const body = buildRequestBody(baseInput);
        expect(body.tools).toBeUndefined();
        expect(body.parallel_tool_calls).toBeUndefined();
    });

    test("builtinTools is not an array — ignored", () => {
        const body = buildRequestBody({
            ...baseInput,
            providerOptions: { builtinTools: "nope" as unknown as readonly object[] },
        });
        expect(body.tools).toBeUndefined();
    });
});
