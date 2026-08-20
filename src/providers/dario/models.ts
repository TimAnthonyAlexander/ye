// dario advertises its own model namespace, not the raw API's. `[1m]` is a
// client-side label: the proxy strips the tag and rides the
// context-1m-2025-08-07 beta instead, which is the only way the subscription
// OAuth path reaches a 1M window. A plain id therefore gets 200K.
const BASE_MODELS: readonly string[] = [
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
];

// dario generates a `[1m]` variant for every family except haiku — real Claude
// Code never offers a 1M haiku.
export const hasLongContextVariant = (model: string): boolean => !model.includes("haiku");

export const longContextId = (model: string): string => `${model}[1m]`;

const buildContextSizes = (): Readonly<Record<string, number>> => {
    const sizes: Record<string, number> = {};
    for (const model of BASE_MODELS) {
        sizes[model] = 200_000;
        if (hasLongContextVariant(model)) sizes[longContextId(model)] = 1_000_000;
    }
    return sizes;
};

export const DARIO_CONTEXT_SIZES: Readonly<Record<string, number>> = buildContextSizes();
