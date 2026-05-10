import { FALLBACK_CONTEXT_WINDOW } from "../../config/index.ts";
import type { Config } from "../../config/index.ts";
import { resolveApiKey } from "../build.ts";
import { classifyHttpError, networkError, streamError } from "../errors.ts";
import type { Provider, ProviderEvent, ProviderInput } from "../types.ts";
import { buildRequestBody } from "./adapt.ts";
import { DEEPSEEK_CONTEXT_SIZES } from "./models.ts";
import { formatDeepSeekError, parseBatch, parseStream } from "./stream.ts";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

export interface DeepSeekDeps {
    readonly apiKey: string;
    readonly baseUrl?: string;
}

export const createDeepSeekProvider = (deps: DeepSeekDeps): Provider => {
    const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;

    const authHeaders: Record<string, string> = {
        Authorization: `Bearer ${deps.apiKey}`,
    };

    return {
        id: "deepseek",
        capabilities: {
            promptCache: true, // Automatic prefix caching, no setup
            toolUse: true,
            vision: false,
            serverSideWebSearch: false,
        },

        async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
            const body = buildRequestBody(input);
            let res: Response;
            try {
                res = await fetch(`${baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: { ...authHeaders, "Content-Type": "application/json" },
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
                const msg = `DeepSeek ${res.status}: ${formatDeepSeekError(text)}`;
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
            return DEEPSEEK_CONTEXT_SIZES[model] ?? FALLBACK_CONTEXT_WINDOW;
        },
    };
};

export class MissingDeepSeekKeyError extends Error {
    constructor(envVar: string) {
        super(`Missing DeepSeek API key. Set ${envVar} in your environment.`);
        this.name = "MissingDeepSeekKeyError";
    }
}

export const buildDeepSeekFromConfig = (config: Config): Provider => {
    const provCfg = config.providers["deepseek"];
    if (!provCfg) {
        throw new Error("deepseek provider missing from config.providers");
    }
    const apiKey = resolveApiKey(provCfg);
    if (!apiKey) {
        throw new MissingDeepSeekKeyError(provCfg.apiKeyEnv);
    }
    return createDeepSeekProvider({ apiKey, baseUrl: provCfg.baseUrl });
};
