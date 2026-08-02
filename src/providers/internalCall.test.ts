import { describe, expect, test } from "bun:test";
import type { Config } from "../config/index.ts";
import { resolveInternalCall, tryResolveCheapModel } from "./internalCall.ts";
import type { Provider, ProviderEvent, ProviderInput } from "./types.ts";

const makeActive = (id = "openrouter"): Provider => ({
    id,
    capabilities: { promptCache: false, toolUse: true, vision: false, serverSideWebSearch: false },
    // eslint-disable-next-line require-yield
    async *stream(_input: ProviderInput): AsyncIterable<ProviderEvent> {
        throw new Error("not called");
    },
    async getContextSize() {
        return 100_000;
    },
});

const makeConfig = (extra: Record<string, unknown> = {}): Config =>
    ({
        defaultProvider: "openrouter",
        providers: {
            openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "YE_TEST_OR_KEY" },
            anthropic: {
                baseUrl: "https://api.anthropic.com",
                apiKeyEnv: "YE_TEST_ANTHROPIC_KEY",
                apiKey: "sk-test",
            },
        },
        defaultModel: { provider: "openrouter", model: "expensive/model" },
        ...extra,
    }) as unknown as Config;

const activeOptions = { providerSort: "price" };

const resolve = (config: Config, kind: "summarize" | "memory" | "title" | "webFetch") =>
    resolveInternalCall({
        config,
        kind,
        activeProvider: makeActive(),
        activeModel: "expensive/model",
        activeProviderOptions: activeOptions,
    });

describe("resolveInternalCall without cheapModel", () => {
    test("keeps the active model and provider options for every kind", () => {
        const config = makeConfig();
        for (const kind of ["summarize", "memory", "title", "webFetch"] as const) {
            const target = resolve(config, kind);
            expect(target.model).toBe("expensive/model");
            expect(target.provider.id).toBe("openrouter");
            expect(target.providerOptions).toEqual(activeOptions);
        }
    });

    test("defaults provider options to an empty object when none are given", () => {
        const target = resolveInternalCall({
            config: makeConfig(),
            kind: "summarize",
            activeProvider: makeActive(),
            activeModel: "expensive/model",
        });
        expect(target.providerOptions).toEqual({});
    });
});

describe("resolveInternalCall with cheapModel", () => {
    test("routes to the cheap model with reasoning disabled", () => {
        const config = makeConfig({ cheapModel: { provider: "openrouter", model: "cheap/model" } });
        const target = resolve(config, "summarize");
        expect(target.model).toBe("cheap/model");
        expect(target.providerOptions).toEqual({ reasoning: false });
    });

    test("reuses the active provider instance when the ids match", () => {
        const active = makeActive();
        const target = resolveInternalCall({
            config: makeConfig({ cheapModel: { provider: "openrouter", model: "cheap/model" } }),
            kind: "memory",
            activeProvider: active,
            activeModel: "expensive/model",
        });
        expect(target.provider).toBe(active);
    });

    test("builds a different provider when the cheap model lives elsewhere", () => {
        const config = makeConfig({
            cheapModel: { provider: "anthropic", model: "claude-haiku-4-5" },
        });
        const target = resolve(config, "title");
        expect(target.provider.id).toBe("anthropic");
        expect(target.model).toBe("claude-haiku-4-5");
    });

    test("falls back to the active model when the cheap provider has no key", () => {
        const config = makeConfig({
            providers: {
                anthropic: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "YE_TEST_NO_KEY" },
            },
            cheapModel: { provider: "anthropic", model: "claude-haiku-4-5" },
        });
        const target = resolve(config, "summarize");
        expect(target.model).toBe("expensive/model");
        expect(target.provider.id).toBe("openrouter");
        expect(target.providerOptions).toEqual(activeOptions);
    });

    test("falls back to the active model when the cheap provider id is unknown", () => {
        const config = makeConfig({ cheapModel: { provider: "nope", model: "cheap/model" } });
        expect(resolve(config, "summarize").model).toBe("expensive/model");
    });
});

describe("resolveInternalCall webFetch precedence", () => {
    test("summarizeModel beats cheapModel", () => {
        const config = makeConfig({
            webTools: { summarizeModel: "explicit/model" },
            cheapModel: { provider: "openrouter", model: "cheap/model" },
        });
        const target = resolve(config, "webFetch");
        expect(target.model).toBe("explicit/model");
        expect(target.provider.id).toBe("openrouter");
        expect(target.providerOptions).toEqual(activeOptions);
    });

    test("cheapModel applies when summarizeModel is unset", () => {
        const config = makeConfig({
            webTools: {},
            cheapModel: { provider: "openrouter", model: "cheap/model" },
        });
        expect(resolve(config, "webFetch").model).toBe("cheap/model");
    });

    test("summarizeModel is ignored by the other call kinds", () => {
        const config = makeConfig({
            webTools: { summarizeModel: "explicit/model" },
            cheapModel: { provider: "openrouter", model: "cheap/model" },
        });
        expect(resolve(config, "summarize").model).toBe("cheap/model");
        expect(resolve(config, "memory").model).toBe("cheap/model");
        expect(resolve(config, "title").model).toBe("cheap/model");
    });
});

describe("tryResolveCheapModel", () => {
    test("returns null when no cheap model is configured", () => {
        expect(tryResolveCheapModel(makeConfig(), makeActive())).toBeNull();
    });

    test("returns null when the cheap provider cannot be built", () => {
        const config = makeConfig({
            providers: {},
            cheapModel: { provider: "anthropic", model: "claude-haiku-4-5" },
        });
        expect(tryResolveCheapModel(config, makeActive())).toBeNull();
    });
});
