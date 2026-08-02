import type {
    BudgetConfig,
    CompactConfig,
    Config,
    FormatConfig,
    GitStatusConfig,
    HookEntry,
    HooksConfig,
    LspConfig,
    LspServerConfig,
    MatcherGroup,
    MaxTurnsConfig,
    ModelSetting,
    PermissionMode,
    PermissionRule,
    PermissionsConfig,
    ProviderConfig,
    ProviderSort,
    RecoveryConfig,
    RecoveryFallbackModel,
    RoutingStrategy,
    SkillsConfig,
    SuggestionsConfig,
    VerifyConfig,
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

const validatePositiveInt = (path: string, value: unknown): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new ConfigValidationError(`${path} must be a positive integer`);
    }
    return value;
};

const validatePositiveNumber = (path: string, value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new ConfigValidationError(`${path} must be a positive number`);
    }
    return value;
};

const validateUnitFraction = (path: string, value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
        throw new ConfigValidationError(`${path} must be a number in (0, 1]`);
    }
    return value;
};

const validateBoolean = (path: string, value: unknown): boolean => {
    if (typeof value !== "boolean") {
        throw new ConfigValidationError(`${path} must be a boolean`);
    }
    return value;
};

const validateNonEmptyString = (path: string, value: unknown): string => {
    if (!isString(value) || value.trim().length === 0) {
        throw new ConfigValidationError(`${path} must be a non-empty string`);
    }
    return value;
};

const validateRecord = <T>(
    path: string,
    value: unknown,
    validateEntry: (entryPath: string, entryValue: unknown) => T,
): Readonly<Record<string, T>> => {
    if (!isObject(value)) {
        throw new ConfigValidationError(`${path} must be an object`);
    }
    const out: Record<string, T> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key.length === 0) {
            throw new ConfigValidationError(`${path} keys must be non-empty`);
        }
        out[key] = validateEntry(`${path}.${key}`, entry);
    }
    return out;
};

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
    const out: {
        threshold: number;
        defaultMaxTokens?: number;
        minReplyTokens?: number;
        snipThreshold?: number;
        snipFloor?: number;
        snipProtectedTail?: number;
        snipMaxPerTurn?: number;
        microcompactThreshold?: number;
        microcompactHotTail?: number;
        microcompactMinBytes?: number;
        collapseThreshold?: number;
        collapsePreserveRecent?: number;
    } = { threshold: value.threshold };
    if (value.defaultMaxTokens !== undefined) {
        out.defaultMaxTokens = validatePositiveInt(
            "compact.defaultMaxTokens",
            value.defaultMaxTokens,
        );
    }
    if (value.minReplyTokens !== undefined) {
        out.minReplyTokens = validatePositiveInt("compact.minReplyTokens", value.minReplyTokens);
    }
    if (value.snipThreshold !== undefined) {
        out.snipThreshold = validateUnitFraction("compact.snipThreshold", value.snipThreshold);
    }
    if (value.snipFloor !== undefined) {
        out.snipFloor = validateUnitFraction("compact.snipFloor", value.snipFloor);
    }
    if (value.snipProtectedTail !== undefined) {
        out.snipProtectedTail = validatePositiveInt(
            "compact.snipProtectedTail",
            value.snipProtectedTail,
        );
    }
    if (value.snipMaxPerTurn !== undefined) {
        out.snipMaxPerTurn = validatePositiveInt("compact.snipMaxPerTurn", value.snipMaxPerTurn);
    }
    if (value.microcompactThreshold !== undefined) {
        out.microcompactThreshold = validateUnitFraction(
            "compact.microcompactThreshold",
            value.microcompactThreshold,
        );
    }
    if (value.microcompactHotTail !== undefined) {
        out.microcompactHotTail = validatePositiveInt(
            "compact.microcompactHotTail",
            value.microcompactHotTail,
        );
    }
    if (value.microcompactMinBytes !== undefined) {
        out.microcompactMinBytes = validatePositiveInt(
            "compact.microcompactMinBytes",
            value.microcompactMinBytes,
        );
    }
    if (value.collapseThreshold !== undefined) {
        out.collapseThreshold = validateUnitFraction(
            "compact.collapseThreshold",
            value.collapseThreshold,
        );
    }
    if (value.collapsePreserveRecent !== undefined) {
        out.collapsePreserveRecent = validatePositiveInt(
            "compact.collapsePreserveRecent",
            value.collapsePreserveRecent,
        );
    }
    return out;
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
    let persistSessionRules: boolean | undefined;
    if (value.persistSessionRules !== undefined) {
        persistSessionRules = validateBoolean(
            "permissions.persistSessionRules",
            value.persistSessionRules,
        );
    }
    return {
        defaultMode: value.defaultMode as PermissionMode,
        rules,
        heuristicGating,
        ...(persistSessionRules !== undefined ? { persistSessionRules } : {}),
    };
};

const SEARCH_FALLBACKS: readonly WebSearchFallback[] = ["duckduckgo", "off"];

const validateStringArray = (path: string, value: unknown): readonly string[] => {
    if (!Array.isArray(value) || !value.every(isString)) {
        throw new ConfigValidationError(`${path} must be string[]`);
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

const validateModelRef = (path: string, value: unknown): RecoveryFallbackModel => {
    if (!isObject(value)) {
        throw new ConfigValidationError(`${path} must be an object`);
    }
    if (!isString(value.provider)) {
        throw new ConfigValidationError(`${path}.provider must be a string`);
    }
    if (!isString(value.model)) {
        throw new ConfigValidationError(`${path}.model must be a string`);
    }
    return { provider: value.provider, model: value.model };
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
        out.fallbackModel = validateModelRef("recovery.fallbackModel", value.fallbackModel);
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

const validateGitStatusConfig = (value: unknown): GitStatusConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError("gitStatus must be an object");
    }
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
        throw new ConfigValidationError("gitStatus.enabled must be a boolean");
    }
    const enabled = value.enabled === undefined ? true : (value.enabled as boolean);
    let maxLines = 30;
    if (value.maxLines !== undefined) {
        if (
            typeof value.maxLines !== "number" ||
            !Number.isInteger(value.maxLines) ||
            value.maxLines <= 0
        ) {
            throw new ConfigValidationError("gitStatus.maxLines must be a positive integer");
        }
        maxLines = value.maxLines;
    }
    return { enabled, maxLines };
};

const validateFormatConfig = (value: unknown): FormatConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError("format must be an object");
    }
    const out: { enabled?: boolean; formatters?: Readonly<Record<string, string>> } = {};
    if (value.enabled !== undefined) {
        out.enabled = validateBoolean("format.enabled", value.enabled);
    }
    if (value.formatters !== undefined) {
        out.formatters = validateRecord(
            "format.formatters",
            value.formatters,
            validateNonEmptyString,
        );
    }
    return out;
};

const validateVerifyConfig = (value: unknown): VerifyConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError("verify must be an object");
    }
    const out: {
        enabled?: boolean;
        lint?: string;
        test?: string;
        typecheck?: string;
        timeoutMs?: number;
    } = {};
    if (value.enabled !== undefined) {
        out.enabled = validateBoolean("verify.enabled", value.enabled);
    }
    if (value.lint !== undefined) {
        out.lint = validateNonEmptyString("verify.lint", value.lint);
    }
    if (value.test !== undefined) {
        out.test = validateNonEmptyString("verify.test", value.test);
    }
    if (value.typecheck !== undefined) {
        out.typecheck = validateNonEmptyString("verify.typecheck", value.typecheck);
    }
    if (value.timeoutMs !== undefined) {
        out.timeoutMs = validatePositiveInt("verify.timeoutMs", value.timeoutMs);
    }
    return out;
};

const validateBudgetConfig = (value: unknown): BudgetConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError("budget must be an object");
    }
    const out: { maxUsd?: number } = {};
    if (value.maxUsd !== undefined) {
        out.maxUsd = validatePositiveNumber("budget.maxUsd", value.maxUsd);
    }
    return out;
};

const validateSuggestionsConfig = (value: unknown): SuggestionsConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError("suggestions must be an object");
    }
    const out: { enabled?: boolean } = {};
    if (value.enabled !== undefined) {
        out.enabled = validateBoolean("suggestions.enabled", value.enabled);
    }
    return out;
};

const validateLspServerConfig = (path: string, value: unknown): LspServerConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError(`${path} must be an object`);
    }
    const command = validateNonEmptyString(`${path}.command`, value.command);
    let args: readonly string[] | undefined;
    if (value.args !== undefined) {
        args = validateStringArray(`${path}.args`, value.args);
    }
    return { command, ...(args !== undefined ? { args } : {}) };
};

const validateLspConfig = (value: unknown): LspConfig => {
    if (!isObject(value)) {
        throw new ConfigValidationError("lsp must be an object");
    }
    const out: { enabled?: boolean; servers?: Readonly<Record<string, LspServerConfig>> } = {};
    if (value.enabled !== undefined) {
        out.enabled = validateBoolean("lsp.enabled", value.enabled);
    }
    if (value.servers !== undefined) {
        out.servers = validateRecord("lsp.servers", value.servers, validateLspServerConfig);
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
        ...(raw.cheapModel !== undefined
            ? { cheapModel: validateModelRef("cheapModel", raw.cheapModel) }
            : {}),
        ...(raw.skills !== undefined ? { skills: validateSkillsConfig(raw.skills) } : {}),
        ...(raw.hooks !== undefined ? { hooks: validateHooksConfig(raw.hooks) } : {}),
        ...(raw.gitStatus !== undefined
            ? { gitStatus: validateGitStatusConfig(raw.gitStatus) }
            : {}),
        ...(raw.format !== undefined ? { format: validateFormatConfig(raw.format) } : {}),
        ...(raw.verify !== undefined ? { verify: validateVerifyConfig(raw.verify) } : {}),
        ...(raw.budget !== undefined ? { budget: validateBudgetConfig(raw.budget) } : {}),
        ...(raw.suggestions !== undefined
            ? { suggestions: validateSuggestionsConfig(raw.suggestions) }
            : {}),
        ...(raw.lsp !== undefined ? { lsp: validateLspConfig(raw.lsp) } : {}),
        ...(raw.autoDetect !== undefined
            ? { autoDetect: validateBoolean("autoDetect", raw.autoDetect) }
            : {}),
    };
};

export { ConfigValidationError };
