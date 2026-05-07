import type { Config } from "./types.ts";

export const DEFAULT_CONFIG: Config = {
  defaultProvider: "openrouter",
  providers: {
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
    },
  },
  defaultModel: {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro",
    providerOrder: ["DeepSeek"],
    allowFallbacks: false,
  },
};
