import { FALLBACK_CONTEXT_WINDOW } from "../../config/index.ts";
import type { Config } from "../../config/index.ts";
import type { Provider, ProviderEvent, ProviderInput } from "../types.ts";
import { buildRequestBody } from "./adapt.ts";
import { parseStream } from "./stream.ts";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const APP_TITLE = "Ye";

export interface OpenRouterDeps {
    readonly apiKey: string;
    readonly baseUrl?: string;
    readonly referer?: string;
}

export const createOpenRouterProvider = (deps: OpenRouterDeps): Provider => {
    const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
    let modelSizeCache: Map<string, number> | null = null;

    const authHeaders: Record<string, string> = {
        Authorization: `Bearer ${deps.apiKey}`,
        "X-OpenRouter-Title": APP_TITLE,
    };
    if (deps.referer) {
        authHeaders["HTTP-Referer"] = deps.referer;
    }

    const fetchAllModelSizes = async (): Promise<Map<string, number>> => {
        const res = await fetch(`${baseUrl}/models`, { headers: authHeaders });
        if (!res.ok) return new Map();
        const json = (await res.json()) as {
            data?: ReadonlyArray<{ id?: string; context_length?: number }>;
        };
        const map = new Map<string, number>();
        for (const m of json.data ?? []) {
            if (typeof m.id === "string" && typeof m.context_length === "number") {
                map.set(m.id, m.context_length);
            }
        }
        return map;
    };

    return {
        id: "openrouter",
        capabilities: { promptCache: false, toolUse: true, vision: false },

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
                yield { type: "stop", reason: "error", error: `network: ${msg}` };
                return;
            }

            if (!res.ok) {
                const text = await res.text().catch(() => "");
                let msg = `OpenRouter ${res.status}`;
                try {
                    const json = JSON.parse(text) as { error?: { message?: string } };
                    if (json.error?.message) msg = json.error.message;
                } catch {
                    if (text.length > 0) msg = `${msg}: ${text}`;
                }
                yield { type: "stop", reason: "error", error: msg };
                return;
            }

            try {
                yield* parseStream(res);
            } catch (err) {
                if (input.signal?.aborted) {
                    yield { type: "stop", reason: "abort" };
                    return;
                }
                const msg = err instanceof Error ? err.message : String(err);
                yield { type: "stop", reason: "error", error: `stream: ${msg}` };
            }
        },

        async getContextSize(model: string): Promise<number> {
            try {
                if (!modelSizeCache) {
                    modelSizeCache = await fetchAllModelSizes();
                }
                return modelSizeCache.get(model) ?? FALLBACK_CONTEXT_WINDOW;
            } catch {
                return FALLBACK_CONTEXT_WINDOW;
            }
        },
    };
};

export class MissingApiKeyError extends Error {
    constructor(envVar: string) {
        super(`Missing API key. Set ${envVar} in your environment.`);
        this.name = "MissingApiKeyError";
    }
}

export const buildOpenRouterFromConfig = (config: Config): Provider => {
    const provCfg = config.providers["openrouter"];
    if (!provCfg) {
        throw new Error("openrouter provider missing from config.providers");
    }
    const apiKey = process.env[provCfg.apiKeyEnv];
    if (!apiKey) {
        throw new MissingApiKeyError(provCfg.apiKeyEnv);
    }
    return createOpenRouterProvider({ apiKey, baseUrl: provCfg.baseUrl });
};
