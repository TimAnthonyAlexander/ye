import type { Config } from "../config/index.ts";
import { buildAnthropicFromConfig, MissingAnthropicKeyError } from "./anthropic/index.ts";
import { buildOpenRouterFromConfig, MissingApiKeyError } from "./openrouter/index.ts";
import type { Provider } from "./types.ts";

export type {
    Message,
    Provider,
    ProviderCapabilities,
    ProviderError,
    ProviderErrorKind,
    ProviderEvent,
    ProviderInput,
    Role,
    StopReason,
    ToolCallRequest,
    ToolDefinition,
} from "./types.ts";
export { MissingApiKeyError } from "./openrouter/index.ts";
export { MissingAnthropicKeyError } from "./anthropic/index.ts";
export {
    defaultModelFor,
    findModel,
    findModelLabel,
    listModels,
    type ModelInfo,
} from "./models.ts";
export {
    type KeyPromptPayload,
    resolveApiKey,
    setProviderApiKey,
    tryBuildProvider,
    type TryBuildArgs,
    type TryBuildResult,
} from "./build.ts";

const builders: Record<string, (config: Config) => Provider> = {
    openrouter: buildOpenRouterFromConfig,
    anthropic: buildAnthropicFromConfig,
};

export const PROVIDER_IDS: readonly string[] = ["openrouter", "anthropic"];

// Surfaced for command-layer error handling: the two missing-key error types
// that callers typically catch. Adding a provider here means catching its
// missing-key variant separately.
export const isMissingKeyError = (
    err: unknown,
): err is MissingApiKeyError | MissingAnthropicKeyError =>
    err instanceof MissingApiKeyError || err instanceof MissingAnthropicKeyError;

export const getProvider = (config: Config, id?: string): Provider => {
    const providerId = id ?? config.defaultProvider;
    const builder = builders[providerId];
    if (!builder) {
        throw new Error(`unknown provider: ${providerId}`);
    }
    return builder(config);
};
