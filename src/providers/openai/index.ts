import { FALLBACK_CONTEXT_WINDOW } from "../../config/index.ts";
import type { Config } from "../../config/index.ts";
import { resolveApiKey } from "../build.ts";
import { classifyHttpError, networkError, streamError } from "../errors.ts";
import type { Provider, ProviderEvent, ProviderInput } from "../types.ts";
import { buildRequestBody } from "./adapt.ts";
import { parseBatch, parseStream } from "./stream.ts";
import { OPENAI_CONTEXT_SIZES } from "./models.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAIDeps {
    readonly apiKey: string;
    readonly baseUrl?: string;
}

export const createOpenAIProvider = (deps: OpenAIDeps): Provider => {
    const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;

    const authHeaders: Record<string, string> = {
        Authorization: `Bearer ${deps.apiKey}`,
    };

    return {
        id: "openai",
        capabilities: {
            promptCache: true, // OpenAI supports prompt caching (90% discount noted in docs)
            toolUse: true,
            vision: true,
            serverSideWebSearch: false, // Hosted web_search exists but not wired in Ye yet
        },

        async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
            const body = buildRequestBody(input);
            let res: Response;
            try {
                res = await fetch(`${baseUrl}/responses`, {
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
                let msg = `OpenAI ${res.status}`;
                try {
                    const json = JSON.parse(text);
                    if (json.error?.message) msg = `${msg}: ${json.error.message}`;
                } catch {
                    if (text.length > 0) msg = `${msg}: ${text.slice(0, 500)}`;
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
            return OPENAI_CONTEXT_SIZES[model] ?? FALLBACK_CONTEXT_WINDOW;
        },
    };
};

export class MissingOpenAIKeyError extends Error {
    constructor(envVar: string) {
        super(`Missing OpenAI API key. Set ${envVar} in your environment.`);
        this.name = "MissingOpenAIKeyError";
    }
}

export const buildOpenAIFromConfig = (config: Config): Provider => {
    const provCfg = config.providers["openai"];
    if (!provCfg) {
        throw new Error("openai provider missing from config.providers");
    }
    const apiKey = resolveApiKey(provCfg);
    if (!apiKey) {
        throw new MissingOpenAIKeyError(provCfg.apiKeyEnv);
    }
    return createOpenAIProvider({ apiKey, baseUrl: provCfg.baseUrl });
};
