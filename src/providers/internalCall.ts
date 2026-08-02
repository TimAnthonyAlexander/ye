import type { Config } from "../config/index.ts";
import { getProvider } from "./index.ts";
import type { Provider } from "./types.ts";

// Model calls the user never reads: shaper summaries, session titles, memory
// selection, WebFetch page summaries. They are short, mechanical, and
// structured, so they run on `config.cheapModel` when one is configured.
export type InternalCallKind = "summarize" | "title" | "memory" | "webFetch";

export interface InternalCallTarget {
    readonly provider: Provider;
    readonly model: string;
    readonly providerOptions: Readonly<Record<string, unknown>>;
}

export interface ResolveInternalCallInput {
    readonly config: Config;
    readonly kind: InternalCallKind;
    readonly activeProvider: Provider;
    readonly activeModel: string;
    readonly activeProviderOptions?: Readonly<Record<string, unknown>>;
}

// Thinking tokens are pure waste on these calls. Providers that cannot turn
// reasoning off ignore the flag — OpenRouter's adapter checks the per-model
// `canDisable` policy before honouring `false`, OpenAI keys off
// `reasoningEffort` instead, and Ollama leaves thinking off unless asked.
const CHEAP_PROVIDER_OPTIONS: Readonly<Record<string, unknown>> = { reasoning: false };

// Build the cheap model's provider, reusing the active one when the ids match.
// Returns null when no cheap model is configured or its provider can't be
// built (missing key, unknown id) — the caller then keeps the active model.
// Losing an auxiliary call is acceptable; losing compaction is not.
export const tryResolveCheapModel = (
    config: Config,
    activeProvider: Provider,
): InternalCallTarget | null => {
    const cheap = config.cheapModel;
    if (!cheap) return null;
    try {
        const provider =
            cheap.provider === activeProvider.id
                ? activeProvider
                : getProvider(config, cheap.provider);
        return { provider, model: cheap.model, providerOptions: CHEAP_PROVIDER_OPTIONS };
    } catch {
        return null;
    }
};

// Precedence: webTools.summarizeModel (WebFetch only, the more specific
// setting) → cheapModel → active provider and model.
export const resolveInternalCall = (input: ResolveInternalCallInput): InternalCallTarget => {
    const active: InternalCallTarget = {
        provider: input.activeProvider,
        model: input.activeModel,
        providerOptions: input.activeProviderOptions ?? {},
    };

    if (input.kind === "webFetch") {
        const explicit = input.config.webTools?.summarizeModel;
        if (explicit && explicit.length > 0) return { ...active, model: explicit };
    }

    return tryResolveCheapModel(input.config, input.activeProvider) ?? active;
};
