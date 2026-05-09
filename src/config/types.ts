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

export type ProviderSort = "price" | "throughput" | "latency";

export interface ModelSetting {
    readonly provider: ProviderId;
    readonly model: string;
    readonly providerOrder?: readonly string[];
    readonly allowFallbacks?: boolean;
    // OpenRouter only: sort candidate sub-providers when no explicit order is
    // given. "price" picks cheapest first; "throughput" / "latency" pick fastest.
    readonly providerSort?: ProviderSort;
}

export interface CompactConfig {
    readonly threshold: number;
    // Default reply token budget the pipeline asks the model for. Phase 4's
    // Budget Reduction shaper may clamp this down on tight turns.
    readonly defaultMaxTokens?: number;
    // Floor below which Budget Reduction gives up — a too-cramped reply ceiling
    // is worse than letting the next (prompt-shrinking) shaper run.
    readonly minReplyTokens?: number;
    // Snip shaper.
    readonly snipThreshold?: number;
    readonly snipFloor?: number;
    readonly snipProtectedTail?: number;
    readonly snipMaxPerTurn?: number;
    // Microcompact shaper.
    readonly microcompactThreshold?: number;
    readonly microcompactHotTail?: number;
    readonly microcompactMinBytes?: number;
    // Context Collapse shaper.
    readonly collapseThreshold?: number;
    readonly collapsePreserveRecent?: number;
}

export interface MaxTurnsConfig {
    readonly master: number;
    readonly subagent: number;
}

export interface RecoveryFallbackModel {
    readonly provider: ProviderId;
    readonly model: string;
}

export interface RecoveryConfig {
    // Max retries per turn for retryable provider errors (rate_limit, overloaded,
    // server, network, max_tokens_invalid). Excludes the streaming→batch
    // fallback, which is a single free retry, and prompt-too-long shaper
    // escalation, which counts each forced shaper as one retry.
    readonly maxRetries?: number;
    // Initial backoff in ms; subsequent attempts double up to backoffMaxMs.
    readonly backoffBaseMs?: number;
    readonly backoffMaxMs?: number;
    // Fallback model used after the primary model exhausts retries. When the
    // provider differs, the recovery layer builds the fallback provider from
    // the same config.providers map.
    readonly fallbackModel?: RecoveryFallbackModel;
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

// Reserved shape for the Skills system. enableClaudeInterop is a placeholder for
// a future opt-in that walks ~/.claude/skills/ alongside ~/.ye/skills/ — the key
// is shipped now (validated, default false) so adding the walker later does not
// require a config-shape migration.
export interface SkillsConfig {
    readonly enableClaudeInterop?: boolean;
}

export interface HookEntry {
    readonly type: "command";
    readonly command: string;
    readonly timeout?: number;
}

export interface MatcherGroup {
    readonly matcher?: string;
    readonly hooks: readonly HookEntry[];
}

export interface HooksConfig {
    readonly PreToolUse?: readonly MatcherGroup[];
    readonly PostToolUse?: readonly MatcherGroup[];
    readonly UserPromptSubmit?: readonly MatcherGroup[];
    readonly Stop?: readonly MatcherGroup[];
    readonly SubagentStop?: readonly MatcherGroup[];
    readonly PreCompact?: readonly MatcherGroup[];
    readonly SessionStart?: readonly MatcherGroup[];
}

export interface Config {
    readonly defaultProvider: ProviderId;
    readonly providers: Readonly<Record<string, ProviderConfig>>;
    readonly defaultModel: ModelSetting;
    readonly compact?: CompactConfig;
    readonly maxTurns?: MaxTurnsConfig;
    readonly permissions?: PermissionsConfig;
    readonly webTools?: WebToolsConfig;
    readonly recovery?: RecoveryConfig;
    readonly skills?: SkillsConfig;
    readonly hooks?: HooksConfig;
}
