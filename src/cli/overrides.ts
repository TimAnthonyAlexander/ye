import type { Config, LoadResult } from "../config/index.ts";
import { defaultModelFor } from "../providers/index.ts";

// The model identity as it sits on disk, captured before an override rewrites
// it. Threaded into App so anything that writes the config back can restore it.
export interface PersistedModel {
    readonly provider: string;
    readonly model: string;
}

export const persistedModelOf = (loaded: LoadResult): PersistedModel => ({
    provider: loaded.config.defaultProvider,
    model: loaded.config.defaultModel.model,
});

// Put the user's own model identity back before a config is written. The API
// key prompt persists the whole in-memory config, which is the one path where
// a run-only --model/--provider could otherwise become permanent.
export const withPersistedModel = (cfg: Config, persisted: PersistedModel | null): Config => {
    if (persisted === null) return cfg;
    return {
        ...cfg,
        defaultProvider: persisted.provider,
        defaultModel: {
            ...cfg.defaultModel,
            provider: persisted.provider,
            model: persisted.model,
        },
    };
};

// --model / --provider apply to the in-memory config for this run only. The
// result is never handed to saveConfig, so nothing reaches ~/.ye/config.json.
// A provider switch without a model carries the registry default for that
// provider, the same rule /provider follows — the configured model id usually
// belongs to the provider being replaced.
export const applyModelOverrides = (
    loaded: LoadResult,
    providerId: string | null,
    model: string | null,
): LoadResult => {
    if (providerId === null && model === null) return loaded;
    const cfg = loaded.config;
    const nextModel =
        model ??
        (providerId === null
            ? cfg.defaultModel.model
            : (defaultModelFor(providerId)?.id ?? cfg.defaultModel.model));
    return {
        ...loaded,
        config: {
            ...cfg,
            ...(providerId === null ? {} : { defaultProvider: providerId }),
            defaultModel: {
                ...cfg.defaultModel,
                ...(providerId === null ? {} : { provider: providerId }),
                model: nextModel,
            },
        },
    };
};
