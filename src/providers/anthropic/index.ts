import { FALLBACK_CONTEXT_WINDOW } from "../../config/index.ts";
import type { Config } from "../../config/index.ts";
import { resolveApiKey } from "../apiKey.ts";
import { classifyHttpError, networkError, streamError } from "../errors.ts";
import type { Provider, ProviderCapabilities, ProviderEvent, ProviderInput } from "../types.ts";
import { buildRequestBody } from "./adapt.ts";
import { ANTHROPIC_CONTEXT_SIZES } from "./models.ts";
import { parseBatch, parseStream } from "./stream.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
    promptCache: true,
    toolUse: true,
    vision: true,
    serverSideWebSearch: true,
};

// Anything reachable at a Messages-API-shaped endpoint shares this adapter and
// stream parser; only these four differ. Defaults reproduce api.anthropic.com.
export interface AnthropicDeps {
    readonly apiKey: string;
    readonly baseUrl?: string;
    readonly id?: string;
    readonly contextSizes?: Readonly<Record<string, number>>;
    readonly capabilities?: ProviderCapabilities;
    // Extra request headers, merged last. dario uses it to blank the
    // user-agent Bun would otherwise send — see dario/passthrough.ts.
    readonly headers?: Readonly<Record<string, string>>;
}

export const createAnthropicProvider = (deps: AnthropicDeps): Provider => {
    const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
    const contextSizes = deps.contextSizes ?? ANTHROPIC_CONTEXT_SIZES;

    const headers: Record<string, string> = {
        "x-api-key": deps.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        ...deps.headers,
    };

    return {
        id: deps.id ?? "anthropic",
        capabilities: deps.capabilities ?? ANTHROPIC_CAPABILITIES,

        async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
            const body = buildRequestBody(input);
            let res: Response;
            try {
                res = await fetch(`${baseUrl}/v1/messages`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                    signal: input.signal,
                });
            } catch (err) {
                if (input.signal?.aborted) {
                    yield { type: "stop", reason: "abort" };
                    return;
                }
                const msg = err instanceof Error ? err.message : String(err);
                yield { type: "stop", reason: "error", error: networkError(`network: ${msg}`) };
                return;
            }

            if (!res.ok) {
                const text = await res.text().catch(() => "");
                let msg = `Anthropic ${res.status}`;
                try {
                    const json = JSON.parse(text) as { error?: { message?: string } };
                    if (json.error?.message) msg = json.error.message;
                } catch {
                    if (text.length > 0) msg = `${msg}: ${text}`;
                }
                yield {
                    type: "stop",
                    reason: "error",
                    error: classifyHttpError({
                        status: res.status,
                        body: text,
                        fallbackMessage: msg,
                    }),
                };
                return;
            }

            try {
                if (input.stream === false) {
                    yield* parseBatch(res);
                } else {
                    yield* parseStream(res);
                }
            } catch (err) {
                if (input.signal?.aborted) {
                    yield { type: "stop", reason: "abort" };
                    return;
                }
                const msg = err instanceof Error ? err.message : String(err);
                yield { type: "stop", reason: "error", error: streamError(`stream: ${msg}`) };
            }
        },

        async getContextSize(model: string): Promise<number> {
            return contextSizes[model] ?? FALLBACK_CONTEXT_WINDOW;
        },
    };
};

export class MissingAnthropicKeyError extends Error {
    constructor(envVar: string) {
        super(`Missing API key. Set ${envVar} in your environment.`);
        this.name = "MissingAnthropicKeyError";
    }
}

export const buildAnthropicFromConfig = (config: Config): Provider => {
    const provCfg = config.providers["anthropic"];
    if (!provCfg) {
        throw new Error("anthropic provider missing from config.providers");
    }
    const apiKey = resolveApiKey(provCfg);
    if (!apiKey) {
        throw new MissingAnthropicKeyError(provCfg.apiKeyEnv);
    }
    return createAnthropicProvider({ apiKey, baseUrl: provCfg.baseUrl });
};
