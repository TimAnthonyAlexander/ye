import type { Config, ProviderConfig } from "../config/index.ts";

// Split out of build.ts so a provider module can resolve its key without
// importing the registry: build.ts pulls in providers/index.ts, which pulls in
// every provider, and a provider importing back into that cycle only evaluates
// cleanly when the registry happens to load first.

// Single resolution rule. Env wins; persisted apiKey is the fallback. Treats
// empty strings as absent — guards against shells that export VAR= without a
// value, and against future hand-edits to config.json.
export const resolveApiKey = (provCfg: ProviderConfig): string | undefined => {
    const fromEnv = process.env[provCfg.apiKeyEnv];
    if (fromEnv && fromEnv.length > 0) return fromEnv;
    if (provCfg.apiKey && provCfg.apiKey.length > 0) return provCfg.apiKey;
    return undefined;
};

// Immutable update. Returns a new Config with the key persisted under
// `providers[providerId].apiKey`. Caller is responsible for saveConfig().
export const setProviderApiKey = (cfg: Config, providerId: string, key: string): Config => {
    const current = cfg.providers[providerId];
    if (!current) {
        throw new Error(`provider ${providerId} not found in config.providers`);
    }
    return {
        ...cfg,
        providers: {
            ...cfg.providers,
            [providerId]: { ...current, apiKey: key },
        },
    };
};
