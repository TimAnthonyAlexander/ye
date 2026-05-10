// Ollama context window discovery. Ollama doesn't publish a flat per-model
// context table — each pulled model's `model_info` exposes an architecture-
// scoped key like `llama.context_length` or `qwen3.context_length`. We POST
// /api/show once per model per session and scan model_info for any
// `*.context_length` field.

import { FALLBACK_CONTEXT_WINDOW } from "../../config/index.ts";

interface OllamaShowResponse {
    readonly model_info?: Readonly<Record<string, unknown>>;
    readonly parameters?: string;
}

interface OllamaTagsResponse {
    readonly models?: ReadonlyArray<{
        readonly name?: string;
        readonly model?: string;
        readonly size?: number;
        readonly details?: {
            readonly parameter_size?: string;
            readonly quantization_level?: string;
        };
    }>;
}

export interface OllamaTag {
    readonly id: string;
    readonly label: string;
    readonly sizeBytes: number;
}

const extractContextFromInfo = (info: Readonly<Record<string, unknown>>): number | null => {
    for (const [key, val] of Object.entries(info)) {
        if (key.endsWith(".context_length") && typeof val === "number" && val > 0) {
            return val;
        }
    }
    return null;
};

// /api/show parameters is a Modelfile-style block; num_ctx is set by Modelfile
// authors to override the architecture default. Honor it when present.
const extractNumCtx = (parameters: string | undefined): number | null => {
    if (!parameters) return null;
    const match = parameters.match(/^\s*num_ctx\s+(\d+)\s*$/m);
    if (!match || !match[1]) return null;
    const n = Number.parseInt(match[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
};

export const fetchContextSize = async (
    baseUrl: string,
    model: string,
    headers: Record<string, string>,
): Promise<number> => {
    try {
        const res = await fetch(`${baseUrl}/api/show`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ model }),
        });
        if (!res.ok) return FALLBACK_CONTEXT_WINDOW;
        const json = (await res.json()) as OllamaShowResponse;
        const fromParams = extractNumCtx(json.parameters);
        if (fromParams) return fromParams;
        const info = json.model_info;
        if (info) {
            const fromInfo = extractContextFromInfo(info);
            if (fromInfo) return fromInfo;
        }
        return FALLBACK_CONTEXT_WINDOW;
    } catch {
        return FALLBACK_CONTEXT_WINDOW;
    }
};

const formatSize = (bytes: number): string => {
    if (bytes <= 0) return "";
    const gb = bytes / 1_000_000_000;
    if (gb >= 1) return `${gb.toFixed(1)}G`;
    const mb = bytes / 1_000_000;
    return `${Math.round(mb)}M`;
};

// List locally pulled models via /api/tags. Returns [] on transport failure
// (e.g. server not running) — caller surfaces a friendly error.
export const fetchOllamaTags = async (
    baseUrl: string,
    headers: Record<string, string>,
): Promise<readonly OllamaTag[]> => {
    const res = await fetch(`${baseUrl}/api/tags`, { headers });
    if (!res.ok) {
        throw new Error(`Ollama /api/tags HTTP ${res.status}`);
    }
    const json = (await res.json()) as OllamaTagsResponse;
    const out: OllamaTag[] = [];
    for (const m of json.models ?? []) {
        const id = m.name ?? m.model;
        if (typeof id !== "string" || id.length === 0) continue;
        const sizeBytes = typeof m.size === "number" ? m.size : 0;
        const sizeLabel = formatSize(sizeBytes);
        const parts: string[] = [id];
        if (sizeLabel) parts.push(`(${sizeLabel})`);
        out.push({ id, label: parts.join(" "), sizeBytes });
    }
    return out;
};
