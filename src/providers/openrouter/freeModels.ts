import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { FREE_MODELS_CACHE_FILE } from "../../storage/paths.ts";

const BASE_URL = "https://openrouter.ai/api/v1";
const MIN_CONTEXT = 32768;
const TEST_DELAY_MS = 250;
const TEST_TOOL_NAME = "ping";
const TEST_PROMPT = "Call the ping tool.";
const CACHE_VERSION = 1;

interface RawModelEntry {
    readonly id?: string;
    readonly name?: string;
    readonly context_length?: number;
    readonly pricing?: {
        readonly prompt?: string;
        readonly completion?: string;
    };
    readonly architecture?: {
        readonly input_modalities?: readonly string[];
    };
}

interface Candidate {
    readonly id: string;
    readonly label: string;
    readonly contextLength: number;
}

export interface FreeModelEntry {
    readonly id: string;
    readonly label: string;
    readonly contextLength: number;
}

interface FreeModelsCacheFile {
    readonly version: typeof CACHE_VERSION;
    readonly refreshedAt: number;
    readonly models: readonly FreeModelEntry[];
}

export interface RefreshResult {
    readonly tested: number;
    readonly passed: number;
    readonly models: readonly FreeModelEntry[];
}

let snapshot: readonly FreeModelEntry[] | null = null;

const PING_TOOL = {
    type: "function" as const,
    function: {
        name: TEST_TOOL_NAME,
        description: "Respond with the string pong to verify tool calling works.",
        parameters: { type: "object", properties: {}, required: [] },
    },
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isFreeText = (m: RawModelEntry): boolean => {
    const pricing = m.pricing;
    if (!pricing) return false;
    if (pricing.prompt !== "0" || pricing.completion !== "0") return false;
    const modes = m.architecture?.input_modalities ?? [];
    if (!modes.includes("text")) return false;
    if (typeof m.context_length !== "number" || m.context_length < MIN_CONTEXT) return false;
    if (typeof m.id !== "string" || m.id.length === 0) return false;
    return true;
};

const fetchCandidates = async (apiKey: string): Promise<Candidate[]> => {
    const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
        throw new Error(`OpenRouter /models HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: readonly RawModelEntry[] };
    const out: Candidate[] = [];
    for (const m of json.data ?? []) {
        if (!isFreeText(m)) continue;
        out.push({
            id: m.id as string,
            label: typeof m.name === "string" && m.name.length > 0 ? m.name : (m.id as string),
            contextLength: m.context_length as number,
        });
    }
    out.sort((a, b) => b.contextLength - a.contextLength);
    return out;
};

const testToolUse = async (modelId: string, apiKey: string): Promise<boolean> => {
    const strictBody = {
        model: modelId,
        messages: [{ role: "user", content: TEST_PROMPT }],
        tools: [PING_TOOL],
        tool_choice: { type: "function", function: { name: TEST_TOOL_NAME } },
        max_tokens: 128,
        temperature: 0,
    };
    const autoBody = {
        model: modelId,
        messages: [{ role: "user", content: TEST_PROMPT }],
        tools: [PING_TOOL],
        max_tokens: 128,
        temperature: 0,
    };

    for (const body of [strictBody, autoBody]) {
        const isStrict = body === strictBody;
        try {
            const res = await fetch(`${BASE_URL}/chat/completions`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                if (isStrict && (text.includes("tool_choice") || text.includes("tool choice"))) {
                    continue;
                }
                return false;
            }
            const json = (await res.json()) as {
                choices?: ReadonlyArray<{
                    message?: {
                        tool_calls?: ReadonlyArray<{ function?: { name?: string } }>;
                    };
                }>;
            };
            const calls = json.choices?.[0]?.message?.tool_calls;
            if (!calls || calls.length === 0) return false;
            return calls[0]?.function?.name === TEST_TOOL_NAME;
        } catch {
            return false;
        }
    }
    return false;
};

export const refreshFreeModels = async (
    apiKey: string,
    onProgress?: (line: string) => void,
): Promise<RefreshResult> => {
    const candidates = await fetchCandidates(apiKey);
    onProgress?.(`Fetched ${candidates.length} candidates. Testing tool-use…`);
    const passed: FreeModelEntry[] = [];
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i] as Candidate;
        const ok = await testToolUse(c.id, apiKey);
        if (ok) {
            passed.push({ id: c.id, label: c.label, contextLength: c.contextLength });
        }
        const flag = ok ? "✓" : "✗";
        onProgress?.(`  [${i + 1}/${candidates.length}] ${flag} ${c.id}`);
        await sleep(TEST_DELAY_MS);
    }
    const cache: FreeModelsCacheFile = {
        version: CACHE_VERSION,
        refreshedAt: Date.now(),
        models: passed,
    };
    await mkdir(dirname(FREE_MODELS_CACHE_FILE), { recursive: true });
    await writeFile(FREE_MODELS_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    snapshot = passed;
    return { tested: candidates.length, passed: passed.length, models: passed };
};

export const loadFreeModelsCache = async (): Promise<readonly FreeModelEntry[] | null> => {
    try {
        const raw = await readFile(FREE_MODELS_CACHE_FILE, "utf8");
        const parsed = JSON.parse(raw) as Partial<FreeModelsCacheFile>;
        if (parsed.version !== CACHE_VERSION) return null;
        if (!Array.isArray(parsed.models)) return null;
        const models: FreeModelEntry[] = [];
        for (const m of parsed.models) {
            if (
                typeof m?.id === "string" &&
                typeof m.label === "string" &&
                typeof m.contextLength === "number"
            ) {
                models.push({ id: m.id, label: m.label, contextLength: m.contextLength });
            }
        }
        snapshot = models;
        return models;
    } catch {
        return null;
    }
};

export const findFreeModelLabel = (id: string): string | undefined =>
    snapshot?.find((m) => m.id === id)?.label;

void loadFreeModelsCache();
