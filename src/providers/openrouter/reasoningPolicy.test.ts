import { describe, expect, test } from "bun:test";
import type { Message, ReasoningDetail } from "../types.ts";
import {
    applyInputPolicy,
    getReasoningPolicy,
    resolveInputPolicy,
    stripAllReasoningDetails,
} from "./reasoningPolicy.ts";

const detail = (text: string): ReasoningDetail => ({
    type: "reasoning.text",
    text,
    format: "anthropic-claude-v1",
});

const assistant = (text: string, reasoning?: readonly ReasoningDetail[]): Message =>
    reasoning
        ? { role: "assistant", content: text, reasoning_details: reasoning }
        : { role: "assistant", content: text };

const user = (text: string): Message => ({ role: "user", content: text });

describe("getReasoningPolicy matrix", () => {
    test("DeepSeek V4 Pro via OR → preserve (OpenRouter strips on most upstreams)", () => {
        const p = getReasoningPolicy("deepseek/deepseek-v4-pro");
        expect(p.input).toBe("preserve");
        expect(p.effort.default).toBe("high");
        expect(p.effort.supported).toEqual(["high", "max"]);
        expect(p.effort.canDisable).toBe(false);
    });

    test("DeepSeek R1 → reject", () => {
        expect(getReasoningPolicy("deepseek/deepseek-r1").input).toBe("reject");
        expect(getReasoningPolicy("deepseek/deepseek-r1-0528").input).toBe("reject");
        expect(getReasoningPolicy("deepseek/deepseek-reasoner").input).toBe("reject");
    });

    test("Gemini 3 Pro Preview → required-on-tool-turns, can't disable", () => {
        const p = getReasoningPolicy("google/gemini-3.1-pro-preview");
        expect(p.input).toBe("required-on-tool-turns");
        expect(p.effort.canDisable).toBe(false);
        expect(p.effort.supported).toEqual(["low", "high"]);
    });

    test("Gemini 2.5 Pro → preserve, no effort levels", () => {
        const p = getReasoningPolicy("google/gemini-2.5-pro");
        expect(p.input).toBe("preserve");
        expect(p.effort.default).toBeNull();
    });

    test("Gemini Flash latest → preserve (conservative)", () => {
        expect(getReasoningPolicy("~google/gemini-flash-latest").input).toBe("preserve");
    });

    test("Anthropic via OR → preserve", () => {
        expect(getReasoningPolicy("anthropic/claude-opus-4.7").input).toBe("preserve");
    });

    test("MiniMax M2.x → preserve", () => {
        expect(getReasoningPolicy("minimax/minimax-m2.5").input).toBe("preserve");
    });

    test("unknown model → preserve (default)", () => {
        expect(getReasoningPolicy("unknown/somemodel").input).toBe("preserve");
    });
});

describe("resolveInputPolicy", () => {
    test("Gemini 3 with no tool calls in history → preserve", () => {
        const msgs: readonly Message[] = [user("hi"), assistant("hello")];
        expect(resolveInputPolicy("google/gemini-3.1-pro-preview", msgs)).toBe("preserve");
    });

    test("Gemini 3 with tool calls in history → required", () => {
        const msgs: readonly Message[] = [
            user("read file"),
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: "t1",
                        type: "function",
                        function: { name: "Read", arguments: "{}" },
                    },
                ],
            },
            { role: "tool", tool_call_id: "t1", content: "..." },
        ];
        expect(resolveInputPolicy("google/gemini-3.1-pro-preview", msgs)).toBe("required");
    });

    test("V4 Pro via OR → preserve (OpenRouter strips field for V4 Pro)", () => {
        expect(resolveInputPolicy("deepseek/deepseek-v4-pro", [])).toBe("preserve");
    });
});

describe("applyInputPolicy", () => {
    test("reject strips reasoning_details from every assistant", () => {
        const msgs: readonly Message[] = [
            user("hi"),
            assistant("hey", [detail("thinking...")]),
            user("more"),
            assistant("ok", [detail("more thinking")]),
        ];
        const out = applyInputPolicy("deepseek/deepseek-r1", msgs);
        expect(out).not.toBe(msgs);
        for (const m of out) {
            expect(m.reasoning_details).toBeUndefined();
        }
    });

    test("reject is a no-op when no reasoning_details present", () => {
        const msgs: readonly Message[] = [user("hi"), assistant("hey")];
        const out = applyInputPolicy("deepseek/deepseek-r1", msgs);
        expect(out).toBe(msgs);
    });

    test("preserve passes through unchanged", () => {
        const msgs: readonly Message[] = [user("hi"), assistant("hey", [detail("thinking...")])];
        const out = applyInputPolicy("anthropic/claude-opus-4.7", msgs);
        expect(out).toBe(msgs);
    });

    // Gemini 3 resolves to required only when tool calls exist in history.
    // Construct that condition to exercise the required-mode branches.
    const toolUseAssistant = {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "Read", arguments: "{}" } }],
        reasoning_details: [detail("r1")],
    } as const satisfies Message;

    test("required with consistent reasoning_details on every assistant → preserves", () => {
        const msgs: readonly Message[] = [
            user("a"),
            toolUseAssistant,
            { role: "tool", tool_call_id: "t1", content: "..." },
            user("c"),
            assistant("d", [detail("r2")]),
        ];
        const out = applyInputPolicy("google/gemini-3.1-pro-preview", msgs);
        expect(out).toBe(msgs);
    });

    test("required with one assistant missing details → strips all (avoid 400)", () => {
        const msgs: readonly Message[] = [
            user("a"),
            toolUseAssistant,
            { role: "tool", tool_call_id: "t1", content: "..." },
            user("c"),
            assistant("d"), // missing — breaks consistency
        ];
        const out = applyInputPolicy("google/gemini-3.1-pro-preview", msgs);
        expect(out).not.toBe(msgs);
        for (const m of out) {
            expect(m.reasoning_details).toBeUndefined();
        }
    });

    test("required with no assistants carrying details → no-op", () => {
        // Same Gemini-3-with-tools scenario but no details anywhere.
        const msgs: readonly Message[] = [
            user("a"),
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    { id: "t1", type: "function", function: { name: "Read", arguments: "{}" } },
                ],
            },
            { role: "tool", tool_call_id: "t1", content: "..." },
            user("c"),
            assistant("d"),
        ];
        const out = applyInputPolicy("google/gemini-3.1-pro-preview", msgs);
        expect(out).toBe(msgs);
    });
});

describe("stripAllReasoningDetails", () => {
    test("strips from every assistant, returns new array", () => {
        const msgs: readonly Message[] = [
            user("a"),
            assistant("b", [detail("r1")]),
            user("c"),
            assistant("d", [detail("r2")]),
        ];
        const out = stripAllReasoningDetails(msgs);
        expect(out).not.toBe(msgs);
        for (const m of out) {
            expect(m.reasoning_details).toBeUndefined();
        }
    });

    test("no-op when none present", () => {
        const msgs: readonly Message[] = [user("a"), assistant("b")];
        expect(stripAllReasoningDetails(msgs)).toBe(msgs);
    });
});
