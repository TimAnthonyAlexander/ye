import type { Config } from "../config/index.ts";
import { buildOpenRouterFromConfig } from "./openrouter/index.ts";
import type { Provider } from "./types.ts";

export type {
  Message,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderInput,
  Role,
  StopReason,
  ToolCallRequest,
  ToolDefinition,
} from "./types.ts";
export { MissingApiKeyError } from "./openrouter/index.ts";

const builders: Record<string, (config: Config) => Provider> = {
  openrouter: buildOpenRouterFromConfig,
};

export const getProvider = (config: Config, id?: string): Provider => {
  const providerId = id ?? config.defaultProvider;
  const builder = builders[providerId];
  if (!builder) {
    throw new Error(`unknown provider: ${providerId}`);
  }
  return builder(config);
};
