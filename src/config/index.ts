export { DEFAULT_CONFIG, FALLBACK_CONTEXT_WINDOW } from "./defaults.ts";
export { loadConfig, saveConfig, type LoadResult } from "./loader.ts";
export { CONFIG_DIR, CONFIG_FILE } from "./paths.ts";
export type {
    CompactConfig,
    Config,
    MaxTurnsConfig,
    ModelSetting,
    OpenRouterProviderSlug,
    PermissionMode,
    PermissionRule,
    PermissionsConfig,
    ProviderConfig,
    ProviderId,
    WebSearchFallback,
    WebToolsConfig,
} from "./types.ts";
export { ConfigValidationError, validateConfig } from "./validate.ts";
