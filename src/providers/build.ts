import type { Config, ProviderConfig } from "../config/index.ts";
import { getProvider, isMissingKeyError } from "./index.ts";
import type { Provider } from "./types.ts";

// Shape consumed by the Ink-side KeyPrompt component. Defined here so build.ts
// has no React/Ink dependency and the component imports the type from us.
export interface KeyPromptPayload {
    readonly title: string;
    readonly description: string;
}

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

export interface TryBuildArgs {
    readonly cfg: Config;
    readonly providerId: string;
    askForKey(payload: KeyPromptPayload): Promise<string | null>;
    persistConfig(next: Config): Promise<void>;
}

export interface TryBuildResult {
    readonly provider: Provider;
    readonly cfg: Config;
}

// Try to build a provider. If its API key is missing, prompt the user via the
// supplied callback, persist the answer to disk, and retry. Returns null if the
// user cancels the prompt.
//
// Pure: takes the prompt + persist callbacks as args so it doesn't capture App
// state. Caller threads the returned cfg back into App's config ref so future
// builds see the persisted key.
export const tryBuildProvider = async (
    args: TryBuildArgs,
): Promise<TryBuildResult | null> => {
    try {
        return { provider: getProvider(args.cfg, args.providerId), cfg: args.cfg };
    } catch (e) {
        if (!isMissingKeyError(e)) throw e;
        const provCfg = args.cfg.providers[args.providerId];
        if (!provCfg) throw e;
        const key = await args.askForKey({
            title: `${args.providerId} API key required`,
            description:
                `${provCfg.apiKeyEnv} is not set. Enter a key — it will be saved to ` +
                `~/.ye/config.json (chmod 0600). The env var still wins on next launch ` +
                `if you set it later. Press Esc to cancel.`,
        });
        if (!key) return null;
        const trimmed = key.trim();
        if (trimmed.length === 0) return null;
        const next = setProviderApiKey(args.cfg, args.providerId, trimmed);
        await args.persistConfig(next);
        return { provider: getProvider(next, args.providerId), cfg: next };
    }
};
