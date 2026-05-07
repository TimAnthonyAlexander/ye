import type { Config, ModelSetting, ProviderConfig } from "./types.ts";

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
  };
};

export { ConfigValidationError };
