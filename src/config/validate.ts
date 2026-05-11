import type {
    CompactConfig,
    Config,
    HookEntry,
    HooksConfig,
    MatcherGroup,
    MaxTurnsConfig,
    ModelSetting,
    PermissionMode,
    PermissionRule,
    PermissionsConfig,
    ProviderConfig,
    ProviderSort,
    RecoveryConfig,
    RoutingStrategy,
    SkillsConfig,
    WebSearchFallback,
    WebToolsConfig,
} from "./types.ts";

const PERMISSION_MODES: readonly PermissionMode[] = ["AUTO", "NORMAL", "PLAN"];
const PROVIDER_SORTS: readonly ProviderSort[] = ["price", "throughput", "latency"];
const ROUTING_STRATEGIES: readonly RoutingStrategy[] = ["cheapest", "fastest", "latency", "sticky"];

class ConfigValidationError extends Error {
    constructor(message: string) {
        super(`Invalid config: ${message}`);
        this.name = "ConfigValidationError";
    }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const validateProviderConfig = (key: string, value: unknown): ProviderConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError(`providers.${key} must be an object`);
    }
    if (!isString(value.baseUrl)) {
        throw new ConfigValidationError(`providers.${key}.baseUrl must be a string`);
    }
    if (!isString(value.apiKeyEnv)) {
        throw new ConfigValidationError(`providers.${key}.apiKeyEnv must be a string`);
    }
    let apiKey: string | undefined;
    if (value.apiKey !== undefined) {
        if (!isString(value.apiKey)) {
            throw new ConfigValidationError(
                `providers.${key}.apiKey must be a string when present`,
            );
        }
        if (value.apiKey.trim().length === 0) {
            throw new ConfigValidationError(
                `providers.${key}.apiKey must be non-empty when present`,
            );
        }
        apiKey = value.apiKey;
    }
    return {
        baseUrl: value.baseUrl,
        apiKeyEnv: value.apiKeyEnv,
        ...(apiKey !== undefined ? { apiKey } : {}),
    };
};

const validateModelSetting = (value: unknown): ModelSetting => {
    if (!isObject(value)) {
        throw new ConfigValidationError("defaultModel must be an object");
    }
    if (!isString(value.provider)) {
        throw new ConfigValidationError("defaultModel.provider must be a string");
    }
    if (!isString(value.model)) {
        throw new ConfigValidationError("defaultModel.model must be a string");
    }

    let providerOrder: readonly string[] | undefined;
    if (value.providerOrder !== undefined) {
        if (!Array.isArray(value.providerOrder) || !value.providerOrder.every(isString)) {
            throw new ConfigValidationError("defaultModel.providerOrder must be string[]");
        }
        providerOrder = value.providerOrder;
    }

    let allowFallbacks: boolean | undefined;
    if (value.allowFallbacks !== undefined) {
        if (typeof value.allowFallbacks !== "boolean") {
            throw new ConfigValidationError("defaultModel.allowFallbacks must be a boolean");
        }
        allowFallbacks = value.allowFallbacks;
    }

    let providerSort: ProviderSort | undefined;
    if (value.providerSort !== undefined) {
        if (
            typeof value.providerSort !== "string" ||
            !PROVIDER_SORTS.includes(value.providerSort as ProviderSort)
        ) {
            throw new ConfigValidationError(
                `defaultModel.providerSort must be one of: ${PROVIDER_SORTS.join(", ")}`,
            );
        }
        providerSort = value.providerSort as ProviderSort;
    }

    let routing: RoutingStrategy | undefined;
    if (value.routing !== undefined) {
        if (
            typeof value.routing !== "string" ||
            !ROUTING_STRATEGIES.includes(value.routing as RoutingStrategy)
        ) {
            throw new ConfigValidationError(
                `defaultModel.routing must be one of: ${ROUTING_STRATEGIES.join(", ")}`,
            );
        }
        routing = value.routing as RoutingStrategy;
    }

    return {
        provider: value.provider,
        model: value.model,
        ...(providerOrder !== undefined ? { providerOrder } : {}),
        ...(allowFallbacks !== undefined ? { allowFallbacks } : {}),
        ...(providerSort !== undefined ? { providerSort } : {}),
        ...(routing !== undefined ? { routing } : {}),
    };
};

const validateCompactConfig = (value: unknown): CompactConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError("compact must be an object");
    }
    if (typeof value.threshold !== "number") {
        throw new ConfigValidationError("compact.threshold must be a number");
    }
    if (value.threshold <= 0 || value.threshold > 1) {
        throw new ConfigValidationError("compact.threshold must be in (0, 1]");
    }
    let defaultMaxTokens: number | undefined;
    if (value.defaultMaxTokens !== undefined) {
        if (
            typeof value.defaultMaxTokens !== "number" ||
            !Number.isInteger(value.defaultMaxTokens) ||
            value.defaultMaxTokens <= 0
        ) {
            throw new ConfigValidationError("compact.defaultMaxTokens must be a positive integer");
        }
        defaultMaxTokens = value.defaultMaxTokens;
    }
    let minReplyTokens: number | undefined;
    if (value.minReplyTokens !== undefined) {
        if (
            typeof value.minReplyTokens !== "number" ||
            !Number.isInteger(value.minReplyTokens) ||
            value.minReplyTokens <= 0
        ) {
            throw new ConfigValidationError("compact.minReplyTokens must be a positive integer");
        }
        minReplyTokens = value.minReplyTokens;
    }
    return {
        threshold: value.threshold,
        ...(defaultMaxTokens !== undefined ? { defaultMaxTokens } : {}),
        ...(minReplyTokens !== undefined ? { minReplyTokens } : {}),
    };
};

const validateMaxTurnsConfig = (value: unknown): MaxTurnsConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError("maxTurns must be an object");
    }
    if (typeof value.master !== "number" || !Number.isInteger(value.master) || value.master <= 0) {
        throw new ConfigValidationError("maxTurns.master must be a positive integer");
    }
    if (
        typeof value.subagent !== "number" ||
        !Number.isInteger(value.subagent) ||
        value.subagent <= 0
    ) {
        throw new ConfigValidationError("maxTurns.subagent must be a positive integer");
    }
    return { master: value.master, subagent: value.subagent };
};

const validatePermissionRule = (index: number, value: unknown): PermissionRule => {
    if (!isObject(value)) {
        throw new ConfigValidationError(`permissions.rules[${index}] must be an object`);
    }
    if (value.effect !== "allow" && value.effect !== "deny") {
        throw new ConfigValidationError(
            `permissions.rules[${index}].effect must be "allow" or "deny"`,
        );
    }
    if (!isString(value.tool)) {
        throw new ConfigValidationError(`permissions.rules[${index}].tool must be a string`);
    }
    if (value.pattern !== undefined && !isString(value.pattern)) {
        throw new ConfigValidationError(`permissions.rules[${index}].pattern must be a string`);
    }
    return {
        effect: value.effect,
        tool: value.tool,
        ...(value.pattern !== undefined ? { pattern: value.pattern } : {}),
    };
};

const validatePermissionsConfig = (value: unknown): PermissionsConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError("permissions must be an object");
    }
    if (
        !isString(value.defaultMode) ||
        !PERMISSION_MODES.includes(value.defaultMode as PermissionMode)
    ) {
        throw new ConfigValidationError(
            `permissions.defaultMode must be one of ${PERMISSION_MODES.join(" | ")}`,
        );
    }
    if (!Array.isArray(value.rules)) {
        throw new ConfigValidationError("permissions.rules must be an array");
    }
    const rules = value.rules.map((rule, i) => validatePermissionRule(i, rule));
    const heuristicGating =
        value.heuristicGating === undefined || typeof value.heuristicGating === "boolean"
            ? (value.heuristicGating as boolean | undefined)
            : (() => {
                  throw new ConfigValidationError(
                      "permissions.heuristicGating must be boolean (default true)",
                  );
              })();
    return { defaultMode: value.defaultMode as PermissionMode, rules, heuristicGating };
};

const SEARCH_FALLBACKS: readonly WebSearchFallback[] = ["duckduckgo", "off"];

const validateStringArray = (path: string, value: unknown): readonly string[] => {
    if (!Array.isArray(value) || !value.every(isString)) {
        throw new ConfigValidationError(`${path} must be string[]`);
    }
    return value;
};

const validatePositiveInt = (path: string, value: unknown): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new ConfigValidationError(`${path} must be a positive integer`);
    }
    return value;
};

const validateWebToolsConfig = (value: unknown): WebToolsConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError("webTools must be an object");
    }
    const out: {
        cacheTtlMs?: number;
        maxFetchBytes?: number;
        maxContentChars?: number;
        allowedDomains?: readonly string[];
        blockedDomains?: readonly string[];
        summarizeModel?: string;
        searchFallback?: WebSearchFallback;
    } = {};
    if (value.cacheTtlMs !== undefined) {
        out.cacheTtlMs = validatePositiveInt("webTools.cacheTtlMs", value.cacheTtlMs);
    }
    if (value.maxFetchBytes !== undefined) {
        out.maxFetchBytes = validatePositiveInt("webTools.maxFetchBytes", value.maxFetchBytes);
    }
    if (value.maxContentChars !== undefined) {
        out.maxContentChars = validatePositiveInt(
            "webTools.maxContentChars",
            value.maxContentChars,
        );
    }
    if (value.allowedDomains !== undefined) {
        out.allowedDomains = validateStringArray("webTools.allowedDomains", value.allowedDomains);
    }
    if (value.blockedDomains !== undefined) {
        out.blockedDomains = validateStringArray("webTools.blockedDomains", value.blockedDomains);
    }
    if (value.summarizeModel !== undefined) {
        if (!isString(value.summarizeModel)) {
            throw new ConfigValidationError("webTools.summarizeModel must be a string");
        }
        out.summarizeModel = value.summarizeModel;
    }
    if (value.searchFallback !== undefined) {
        if (
            !isString(value.searchFallback) ||
            !SEARCH_FALLBACKS.includes(value.searchFallback as WebSearchFallback)
        ) {
            throw new ConfigValidationError(
                `webTools.searchFallback must be one of ${SEARCH_FALLBACKS.join(" | ")}`,
            );
        }
        out.searchFallback = value.searchFallback as WebSearchFallback;
    }
    return out;
};

const validateRecoveryConfig = (value: unknown): RecoveryConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError("recovery must be an object");
    }
    const out: {
        maxRetries?: number;
        backoffBaseMs?: number;
        backoffMaxMs?: number;
        rateLimitMaxRetries?: number;
        rateLimitBackoffBaseMs?: number;
        rateLimitBackoffMaxMs?: number;
        fallbackModel?: { provider: string; model: string };
    } = {};
    if (value.maxRetries !== undefined) {
        if (
            typeof value.maxRetries !== "number" ||
            !Number.isInteger(value.maxRetries) ||
            value.maxRetries < 0
        ) {
            throw new ConfigValidationError("recovery.maxRetries must be a non-negative integer");
        }
        out.maxRetries = value.maxRetries;
    }
    if (value.backoffBaseMs !== undefined) {
        out.backoffBaseMs = validatePositiveInt("recovery.backoffBaseMs", value.backoffBaseMs);
    }
    if (value.backoffMaxMs !== undefined) {
        out.backoffMaxMs = validatePositiveInt("recovery.backoffMaxMs", value.backoffMaxMs);
    }
    if (value.rateLimitMaxRetries !== undefined) {
        if (
            typeof value.rateLimitMaxRetries !== "number" ||
            !Number.isInteger(value.rateLimitMaxRetries) ||
            value.rateLimitMaxRetries < 0
        ) {
            throw new ConfigValidationError(
                "recovery.rateLimitMaxRetries must be a non-negative integer",
            );
        }
        out.rateLimitMaxRetries = value.rateLimitMaxRetries;
    }
    if (value.rateLimitBackoffBaseMs !== undefined) {
        out.rateLimitBackoffBaseMs = validatePositiveInt(
            "recovery.rateLimitBackoffBaseMs",
            value.rateLimitBackoffBaseMs,
        );
    }
    if (value.rateLimitBackoffMaxMs !== undefined) {
        out.rateLimitBackoffMaxMs = validatePositiveInt(
            "recovery.rateLimitBackoffMaxMs",
            value.rateLimitBackoffMaxMs,
        );
    }
    if (value.fallbackModel !== undefined) {
        if (!isObject(value.fallbackModel)) {
            throw new ConfigValidationError("recovery.fallbackModel must be an object");
        }
        if (!isString(value.fallbackModel.provider)) {
            throw new ConfigValidationError("recovery.fallbackModel.provider must be a string");
        }
        if (!isString(value.fallbackModel.model)) {
            throw new ConfigValidationError("recovery.fallbackModel.model must be a string");
        }
        out.fallbackModel = {
            provider: value.fallbackModel.provider,
            model: value.fallbackModel.model,
        };
    }
    return out;
};

const validateHookEntry = (path: string, value: unknown): HookEntry => {
    if (!isObject(value)) {
        throw new ConfigValidationError(`${path} must be an object`);
    }
    if (value.type !== "command") {
        throw new ConfigValidationError(`${path}.type must be "command"`);
    }
    if (!isString(value.command) || value.command.trim().length === 0) {
        throw new ConfigValidationError(`${path}.command must be a non-empty string`);
    }
    let timeout: number | undefined;
    if (value.timeout !== undefined) {
        if (
            typeof value.timeout !== "number" ||
            !Number.isInteger(value.timeout) ||
            value.timeout <= 0
        ) {
            throw new ConfigValidationError(`${path}.timeout must be a positive integer`);
        }
        timeout = value.timeout;
    }
    return {
        type: "command",
        command: value.command,
        ...(timeout !== undefined ? { timeout } : {}),
    };
};

const validateMatcherGroup = (path: string, value: unknown): MatcherGroup => {
    if (!isObject(value)) {
        throw new ConfigValidationError(`${path} must be an object`);
    }
    let matcher: string | undefined;
    if (value.matcher !== undefined) {
        if (!isString(value.matcher) || value.matcher.trim().length === 0) {
            throw new ConfigValidationError(`${path}.matcher must be a non-empty string`);
        }
        try {
            new RegExp(value.matcher);
        } catch {
            throw new ConfigValidationError(`${path}.matcher is not a valid regex`);
        }
        matcher = value.matcher;
    }
    if (!Array.isArray(value.hooks) || value.hooks.length === 0) {
        throw new ConfigValidationError(`${path}.hooks must be a non-empty array`);
    }
    const hooks = value.hooks.map((h: unknown, i: number) =>
        validateHookEntry(`${path}.hooks[${i}]`, h),
    );
    return {
        ...(matcher !== undefined ? { matcher } : {}),
        hooks,
    };
};

const HOOK_EVENTS: readonly string[] = [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "Stop",
    "SubagentStop",
    "PreCompact",
    "SessionStart",
];

const validateHooksConfig = (value: unknown): HooksConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError("hooks must be an object");
    }
    const out: Record<string, readonly MatcherGroup[]> = {};
    for (const [key, val] of Object.entries(value)) {
        if (!HOOK_EVENTS.includes(key)) {
            throw new ConfigValidationError(
                `hooks.${key} is not a valid hook event (must be one of ${HOOK_EVENTS.join(" | ")})`,
            );
        }
        if (!Array.isArray(val)) {
            throw new ConfigValidationError(`hooks.${key} must be an array`);
        }
        out[key] = (val as unknown[]).map((g, i) => validateMatcherGroup(`hooks.${key}[${i}]`, g));
    }
    return out;
};

const validateSkillsConfig = (value: unknown): SkillsConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError("skills must be an object");
    }
    const out: { enableClaudeInterop?: boolean } = {};
    if (value.enableClaudeInterop !== undefined) {
        if (typeof value.enableClaudeInterop !== "boolean") {
            throw new ConfigValidationError("skills.enableClaudeInterop must be a boolean");
        }
        out.enableClaudeInterop = value.enableClaudeInterop;
    }
    return out;
};

export const validateConfig = (raw: unknown): Config => {
    if (!isObject(raw)) {
        throw new ConfigValidationError("root must be an object");
    }
    if (!isString(raw.defaultProvider)) {
        throw new ConfigValidationError("defaultProvider must be a string");
    }
    if (!isObject(raw.providers)) {
        throw new ConfigValidationError("providers must be an object");
    }

    const providers: Record<string, ProviderConfig> = {};
    for (const [key, value] of Object.entries(raw.providers)) {
        providers[key] = validateProviderConfig(key, value);
    }

    return {
        defaultProvider: raw.defaultProvider,
        providers,
        defaultModel: validateModelSetting(raw.defaultModel),
        ...(raw.compact !== undefined ? { compact: validateCompactConfig(raw.compact) } : {}),
        ...(raw.maxTurns !== undefined ? { maxTurns: validateMaxTurnsConfig(raw.maxTurns) } : {}),
        ...(raw.permissions !== undefined
            ? { permissions: validatePermissionsConfig(raw.permissions) }
            : {}),
        ...(raw.webTools !== undefined ? { webTools: validateWebToolsConfig(raw.webTools) } : {}),
        ...(raw.recovery !== undefined ? { recovery: validateRecoveryConfig(raw.recovery) } : {}),
        ...(raw.skills !== undefined ? { skills: validateSkillsConfig(raw.skills) } : {}),
        ...(raw.hooks !== undefined ? { hooks: validateHooksConfig(raw.hooks) } : {}),
    };
};

export { ConfigValidationError };
