import type { Config } from "./types.ts";

export const DEFAULT_CONFIG: Config = {
    defaultProvider: "openrouter",
    providers: {
        openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            apiKeyEnv: "OPENROUTER_API_KEY",
        },
        anthropic: {
            baseUrl: "https://api.anthropic.com",
            apiKeyEnv: "ANTHROPIC_API_KEY",
        },
    },
    defaultModel: {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-pro",
        providerOrder: ["DeepSeek"],
        allowFallbacks: false,
    },
    compact: {
        threshold: 0.5,
        defaultMaxTokens: 16_384,
        minReplyTokens: 1024,
    },
    maxTurns: {
        master: 100,
        subagent: 25,
    },
    permissions: {
        defaultMode: "NORMAL",
        rules: [],
    },
};

export const FALLBACK_CONTEXT_WINDOW = 128_000;
