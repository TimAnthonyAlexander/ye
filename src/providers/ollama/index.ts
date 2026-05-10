import type { Config } from "../../config/index.ts";
import { resolveApiKey } from "../build.ts";
import { classifyHttpError, networkError, streamError } from "../errors.ts";
import type { Provider, ProviderEvent, ProviderInput } from "../types.ts";
import { buildRequestBody } from "./adapt.ts";
import { fetchContextSize } from "./models.ts";
import { parseBatch, parseStream } from "./stream.ts";

const DEFAULT_BASE_URL = "http://localhost:11434";

export interface OllamaDeps {
    readonly apiKey?: string;
    readonly baseUrl?: string;
}

export const createOllamaProvider = (deps: OllamaDeps): Provider => {
    const baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const contextCache = new Map<string, number>();

    const baseHeaders: Record<string, string> = {};
    if (deps.apiKey && deps.apiKey.length > 0) {
        baseHeaders.Authorization = `Bearer ${deps.apiKey}`;
    }

    return {
        id: "ollama",
        capabilities: {
            promptCache: false,
            toolUse: true,
            vision: true,
            serverSideWebSearch: false,
        },

        async *stream(input: ProviderInput): AsyncIterable<ProviderEvent> {
            const body = buildRequestBody(input);
            let res: Response;
            try {
                res = await fetch(`${baseUrl}/api/chat`, {
                    method: "POST",
                    headers: { ...baseHeaders, "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                    signal: input.signal,
                });
            } catch (err) {
                if (input.signal?.aborted) {
                    yield { type: "stop", reason: "abort" };
                    return;
                }
                const msg = err instanceof Error ? err.message : String(err);
                yield {
                    type: "stop",
                    reason: "error",
                    error: networkError(`network: ${msg} (is ollama running at ${baseUrl}?)`),
                };
                return;
            }

            if (!res.ok) {
                const text = await res.text().catch(() => "");
                let msg = `Ollama ${res.status}`;
                try {
                    const json = JSON.parse(text) as { error?: string };
                    if (json.error) msg = `${msg}: ${json.error}`;
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
            const cached = contextCache.get(model);
            if (cached !== undefined) return cached;
            const size = await fetchContextSize(baseUrl, model, baseHeaders);
            contextCache.set(model, size);
            return size;
        },
    };
};

export const buildOllamaFromConfig = (config: Config): Provider => {
    const provCfg = config.providers["ollama"];
    if (!provCfg) {
        throw new Error("ollama provider missing from config.providers");
    }
    // Ollama runs locally with no auth by default. The apiKey is only needed
    // for ollama.com cloud routes, so its absence is not an error here — we
    // skip the MissingKey throw the other providers raise.
    const apiKey = resolveApiKey(provCfg);
    return createOllamaProvider({
        ...(apiKey !== undefined ? { apiKey } : {}),
        baseUrl: provCfg.baseUrl,
    });
};
