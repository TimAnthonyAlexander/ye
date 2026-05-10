import { describe, expect, test } from "bun:test";
import { computeCostUsd, lookupPricing } from "./pricing.ts";

describe("lookupPricing", () => {
    test("anthropic models resolve", () => {
        const p = lookupPricing("anthropic", "claude-opus-4-7");
        expect(p?.input).toBe(5.0);
        expect(p?.output).toBe(25.0);
    });

    test("openai models resolve", () => {
        const p = lookupPricing("openai", "gpt-5.5");
        expect(p?.input).toBe(5.0);
        expect(p?.output).toBe(30.0);
    });

    test("deepseek-v4-pro resolves (75% promotional rate)", () => {
        const p = lookupPricing("deepseek", "deepseek-v4-pro");
        expect(p?.input).toBe(0.435);
        expect(p?.output).toBe(0.87);
        expect(p?.cacheRead).toBe(0.003625);
    });

    test("deepseek-v4-flash resolves", () => {
        const p = lookupPricing("deepseek", "deepseek-v4-flash");
        expect(p?.input).toBe(0.14);
        expect(p?.output).toBe(0.28);
        expect(p?.cacheRead).toBe(0.0028);
    });

    test("legacy deepseek-chat / deepseek-reasoner alias to V4 Flash pricing", () => {
        expect(lookupPricing("deepseek", "deepseek-chat")?.input).toBe(0.14);
        expect(lookupPricing("deepseek", "deepseek-reasoner")?.input).toBe(0.14);
    });

    test("openrouter and unknown providers return undefined (cost from API)", () => {
        expect(lookupPricing("openrouter", "deepseek/deepseek-v4-pro")).toBeUndefined();
        expect(lookupPricing("ollama", "qwen3")).toBeUndefined();
        expect(lookupPricing("unknown", "anything")).toBeUndefined();
    });
});

describe("computeCostUsd", () => {
    test("deepseek V4 Pro: 1M input + 1M output", () => {
        const c = computeCostUsd("deepseek", "deepseek-v4-pro", {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
        });
        expect(c).toBeCloseTo(0.435 + 0.87, 6);
    });

    test("deepseek V4 Pro: cache-hit input billed at cacheRead rate", () => {
        const c = computeCostUsd("deepseek", "deepseek-v4-pro", {
            inputTokens: 100_000, // billable miss
            outputTokens: 50_000,
            cacheReadTokens: 900_000,
        });
        // 100k * 0.435 + 50k * 0.87 + 900k * 0.003625, all / 1M
        const expected = (100_000 * 0.435 + 50_000 * 0.87 + 900_000 * 0.003625) / 1_000_000;
        expect(c).toBeCloseTo(expected, 6);
    });

    test("openrouter returns undefined (cost comes from API)", () => {
        const c = computeCostUsd("openrouter", "deepseek/deepseek-v4-pro", {
            inputTokens: 1000,
            outputTokens: 1000,
        });
        expect(c).toBeUndefined();
    });
});
