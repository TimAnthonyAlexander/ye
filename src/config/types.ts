export type ProviderId = "openrouter" | (string & {});

export type OpenRouterProviderSlug =
    | "DeepSeek"
    | "GMICloud"
    | "AtlasCloud"
    | "Venice"
    | "SiliconFlow"
    | "Parasail";

export type PermissionMode = "AUTO" | "NORMAL" | "PLAN";

export interface ProviderConfig {
    readonly baseUrl: string;
    readonly apiKeyEnv: string;
    // Optional fallback when the env var named in apiKeyEnv is unset. Written by
    // the in-app key prompt; env var still wins when both are present.
    readonly apiKey?: string;
}

export interface ModelSetting {
    readonly provider: ProviderId;
    readonly model: string;
    readonly providerOrder?: readonly string[];
    readonly allowFallbacks?: boolean;
}

export interface CompactConfig {
    readonly threshold: number;
    // Default reply token budget the pipeline asks the model for. Phase 4's
    // Budget Reduction shaper may clamp this down on tight turns.
    readonly defaultMaxTokens?: number;
    // Floor below which Budget Reduction gives up — a too-cramped reply ceiling
    // is worse than letting the next (prompt-shrinking) shaper run.
    readonly minReplyTokens?: number;
}

export interface MaxTurnsConfig {
    readonly master: number;
    readonly subagent: number;
}

export interface PermissionRule {
    readonly effect: "allow" | "deny";
    readonly tool: string;
    readonly pattern?: string;
}

export interface PermissionsConfig {
    readonly defaultMode: PermissionMode;
    readonly rules: readonly PermissionRule[];
}

export type WebSearchFallback = "duckduckgo" | "off";

export interface WebToolsConfig {
    readonly cacheTtlMs?: number;
    readonly maxFetchBytes?: number;
    readonly maxContentChars?: number;
    readonly allowedDomains?: readonly string[];
    readonly blockedDomains?: readonly string[];
    // When unset, WebFetch's summariser uses the active provider's active model.
    readonly summarizeModel?: string;
    readonly searchFallback?: WebSearchFallback;
}

export interface Config {
    readonly defaultProvider: ProviderId;
    readonly providers: Readonly<Record<string, ProviderConfig>>;
    readonly defaultModel: ModelSetting;
    readonly compact?: CompactConfig;
    readonly maxTurns?: MaxTurnsConfig;
    readonly permissions?: PermissionsConfig;
    readonly webTools?: WebToolsConfig;
}
