import { describe, expect, test } from "bun:test";
import type { LoadResult } from "../config/index.ts";
import { defaultModelFor } from "../providers/index.ts";
import { applyModelOverrides } from "./overrides.ts";

const loaded: LoadResult = {
    path: "/tmp/config.json",
    created: false,
    config: {
        defaultProvider: "openrouter",
        providers: { openrouter: { baseUrl: "https://x", apiKeyEnv: "OPENROUTER_API_KEY" } },
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
