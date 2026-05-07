import type {
    CompactConfig,
    Config,
    MaxTurnsConfig,
    ModelSetting,
    PermissionMode,
    PermissionRule,
    PermissionsConfig,
    ProviderConfig,
} from "./types.ts";

const PERMISSION_MODES: readonly PermissionMode[] = ["AUTO", "NORMAL", "PLAN"];

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
    return { baseUrl: value.baseUrl, apiKeyEnv: value.apiKeyEnv };
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

    return {
        provider: value.provider,
        model: value.model,
        ...(providerOrder !== undefined ? { providerOrder } : {}),
        ...(allowFallbacks !== undefined ? { allowFallbacks } : {}),
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
    return { threshold: value.threshold };
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
    return { defaultMode: value.defaultMode as PermissionMode, rules };
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
    };
};

export { ConfigValidationError };
