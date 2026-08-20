import { describe, expect, test } from "bun:test";
import { FALLBACK_CONTEXT_WINDOW } from "../../config/index.ts";
import type { Config } from "../../config/index.ts";
import { DEFAULT_CONFIG } from "../../config/defaults.ts";
import { createAnthropicProvider } from "../anthropic/index.ts";
import { ANTHROPIC_CONTEXT_SIZES } from "../anthropic/models.ts";
import { defaultModelFor, listModels } from "../models.ts";
import { computeCostUsd, lookupPricing } from "../pricing.ts";
import { PROVIDER_IDS } from "../index.ts";
import { buildDarioFromConfig } from "./index.ts";
import { DARIO_CONTEXT_SIZES } from "./models.ts";

const withProviders = (providers: Config["providers"]): Config => ({
    ...DEFAULT_CONFIG,
    providers,
});

describe("createAnthropicProvider parametrization", () => {
    test("defaults reproduce the existing anthropic provider", async () => {
        const provider = createAnthropicProvider({ apiKey: "k" });
        expect(provider.id).toBe("anthropic");
        expect(provider.capabilities).toEqual({
            promptCache: true,
            toolUse: true,
            vision: true,
            serverSideWebSearch: true,
        });
        expect(await provider.getContextSize("claude-opus-4-8")).toBe(
            ANTHROPIC_CONTEXT_SIZES["claude-opus-4-8"] ?? 0,
        );
    });

    test("an override changes id, capabilities and context table together", async () => {
        const provider = createAnthropicProvider({
            apiKey: "k",
            id: "dario",
            contextSizes: { "some-model": 12_345 },
            capabilities: {
                promptCache: true,
                toolUse: true,
                vision: true,
                serverSideWebSearch: false,
            },
        });
        expect(provider.id).toBe("dario");
        expect(provider.capabilities.serverSideWebSearch).toBe(false);
        expect(await provider.getContextSize("some-model")).toBe(12_345);
        expect(await provider.getContextSize("unknown")).toBe(FALLBACK_CONTEXT_WINDOW);
    });
});

describe("buildDarioFromConfig", () => {
    test("builds without a key and never throws a missing-key error", () => {
        const provider = buildDarioFromConfig(DEFAULT_CONFIG);
        expect(provider.id).toBe("dario");
        expect(provider.capabilities.serverSideWebSearch).toBe(false);
        expect(provider.capabilities.promptCache).toBe(true);
    });

    test("throws when the provider block is absent", () => {
        const { dario: _dropped, ...rest } = DEFAULT_CONFIG.providers;
        expect(() => buildDarioFromConfig(withProviders(rest))).toThrow(/dario provider missing/);
    });

    test("a persisted apiKey is used when present", () => {
        const cfg = withProviders({
            ...DEFAULT_CONFIG.providers,
            dario: {
                baseUrl: "http://127.0.0.1:9999",
                apiKeyEnv: "DARIO_API_KEY",
                apiKey: "shared-secret",
            },
        });
        expect(() => buildDarioFromConfig(cfg)).not.toThrow();
    });
});

describe("context sizes", () => {
    test("plain ids are 200K, [1m] labels are 1M", () => {
        expect(DARIO_CONTEXT_SIZES["claude-opus-5"]).toBe(200_000);
        expect(DARIO_CONTEXT_SIZES["claude-opus-5[1m]"]).toBe(1_000_000);
        expect(DARIO_CONTEXT_SIZES["claude-sonnet-5[1m]"]).toBe(1_000_000);
        expect(DARIO_CONTEXT_SIZES["claude-fable-5[1m]"]).toBe(1_000_000);
    });

    test("haiku has no long-context variant", () => {
        expect(DARIO_CONTEXT_SIZES["claude-haiku-4-5"]).toBe(200_000);
        expect(DARIO_CONTEXT_SIZES["claude-haiku-4-5[1m]"]).toBeUndefined();
    });

    test("an unknown id falls back", async () => {
        const provider = buildDarioFromConfig(DEFAULT_CONFIG);
        expect(await provider.getContextSize("claude-nope-9")).toBe(FALLBACK_CONTEXT_WINDOW);
    });
});

describe("registry wiring", () => {
    test("PROVIDER_IDS includes dario", () => {
        expect(PROVIDER_IDS).toContain("dario");
    });

    test("the default config ships a dario block with a distinct env var", () => {
        const block = DEFAULT_CONFIG.providers["dario"];
        expect(block?.baseUrl).toBe("http://localhost:3456");
        expect(block?.apiKeyEnv).toBe("DARIO_API_KEY");
        expect(block?.apiKeyEnv).not.toBe(DEFAULT_CONFIG.providers["anthropic"]?.apiKeyEnv);
    });

    test("dario models are registered and default to Opus 4.8", () => {
        const models = listModels("dario");
        expect(models.length).toBeGreaterThan(0);
        expect(defaultModelFor("dario")?.id).toBe("claude-opus-4-8");
        expect(models.map((m) => m.id)).toContain("claude-opus-5[1m]");
    });

    test("every registered dario model has a context size", () => {
        for (const model of listModels("dario")) {
            expect(DARIO_CONTEXT_SIZES[model.id]).toBeGreaterThan(0);
        }
    });
});

describe("pricing", () => {
    test("subscription turns carry no per-token cost", () => {
        expect(lookupPricing("dario", "claude-opus-5")).toBeUndefined();
        expect(
            computeCostUsd("dario", "claude-opus-5", {
                inputTokens: 1_000,
                outputTokens: 1_000,
            }),
        ).toBeUndefined();
    });

    test("the per-token anthropic provider still prices the same models", () => {
        expect(lookupPricing("anthropic", "claude-opus-5")).toEqual({
            input: 5.0,
            output: 25.0,
            cacheRead: 0.5,
            cacheWrite: 6.25,
        });
        expect(lookupPricing("anthropic", "claude-opus-4-8")?.input).toBe(5.0);
    });
});
