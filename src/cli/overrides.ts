import type { LoadResult } from "../config/index.ts";
import { defaultModelFor } from "../providers/index.ts";

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
