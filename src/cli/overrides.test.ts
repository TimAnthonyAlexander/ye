import { describe, expect, test } from "bun:test";
import type { Config, LoadResult } from "../config/index.ts";
import { defaultModelFor, tryBuildProvider } from "../providers/index.ts";
import { applyModelOverrides, persistedModelOf, withPersistedModel } from "./overrides.ts";

const loaded: LoadResult = {
    path: "/tmp/config.json",
    created: false,
    config: {
        defaultProvider: "openrouter",
        providers: {
            openrouter: { baseUrl: "https://x", apiKeyEnv: "OPENROUTER_API_KEY" },
            anthropic: { baseUrl: "https://y", apiKeyEnv: "YE_TEST_KEY_THAT_IS_NEVER_SET" },
        },
        defaultModel: { provider: "openrouter", model: "~google/gemini-flash-latest" },
    },
};

describe("applyModelOverrides", () => {
    test("no overrides returns the same object", () => {
        expect(applyModelOverrides(loaded, null, null)).toBe(loaded);
    });

    test("--model replaces only the model", () => {
        const out = applyModelOverrides(loaded, null, "openai/gpt-5");
        expect(out.config.defaultModel.model).toBe("openai/gpt-5");
        expect(out.config.defaultProvider).toBe("openrouter");
        expect(out.config.defaultModel.provider).toBe("openrouter");
    });

    test("--provider replaces both provider fields and picks that provider's default model", () => {
        const fallback = defaultModelFor("anthropic");
        if (!fallback) throw new Error("anthropic has no registry default model");
        const out = applyModelOverrides(loaded, "anthropic", null);
        expect(out.config.defaultProvider).toBe("anthropic");
        expect(out.config.defaultModel.provider).toBe("anthropic");
        expect(out.config.defaultModel.model).toBe(fallback.id);
    });

    test("--model wins over the provider default when both are given", () => {
        const out = applyModelOverrides(loaded, "ollama", "llama3.2");
        expect(out.config.defaultProvider).toBe("ollama");
        expect(out.config.defaultModel.model).toBe("llama3.2");
    });

    test("the input config is not mutated", () => {
        applyModelOverrides(loaded, "openai", "openai/gpt-5");
        expect(loaded.config.defaultProvider).toBe("openrouter");
        expect(loaded.config.defaultModel.model).toBe("~google/gemini-flash-latest");
    });
});

describe("withPersistedModel", () => {
    test("restores the on-disk model identity", () => {
        const overridden = applyModelOverrides(loaded, "anthropic", "claude-x").config;
        const restored = withPersistedModel(overridden, persistedModelOf(loaded));
        expect(restored.defaultProvider).toBe("openrouter");
        expect(restored.defaultModel.provider).toBe("openrouter");
        expect(restored.defaultModel.model).toBe("~google/gemini-flash-latest");
    });

    test("keeps every other field of the config", () => {
        const overridden = applyModelOverrides(loaded, "anthropic", "claude-x").config;
        const withKey: Config = {
            ...overridden,
            providers: {
                ...overridden.providers,
                anthropic: { ...overridden.providers["anthropic"]!, apiKey: "sk-typed" },
            },
        };
        const restored = withPersistedModel(withKey, persistedModelOf(loaded));
        expect(restored.providers["anthropic"]?.apiKey).toBe("sk-typed");
    });

    test("a run with no override is left alone", () => {
        expect(withPersistedModel(loaded.config, null)).toBe(loaded.config);
    });
});

describe("key prompt during an overridden run", () => {
    test("persists the typed key but not the run-only model identity", async () => {
        const run = applyModelOverrides(loaded, "anthropic", "claude-x");
        const persisted = persistedModelOf(loaded);
        let saved: Config | null = null;

        const built = await tryBuildProvider({
            cfg: run.config,
            providerId: "anthropic",
            askForKey: async () => "sk-typed",
            persistConfig: async (next) => {
                saved = withPersistedModel(next, persisted);
            },
        });

        expect(built).not.toBeNull();
        // The live session keeps the override…
        expect(built?.cfg.defaultProvider).toBe("anthropic");
        expect(built?.cfg.defaultModel.model).toBe("claude-x");
        // …and the file gets the key without it.
        const written = saved as Config | null;
        expect(written).not.toBeNull();
        expect(written?.providers["anthropic"]?.apiKey).toBe("sk-typed");
        expect(written?.defaultProvider).toBe("openrouter");
        expect(written?.defaultModel.provider).toBe("openrouter");
        expect(written?.defaultModel.model).toBe("~google/gemini-flash-latest");
    });
});
