import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { USAGE_FILE } from "./paths.ts";

export type UsageCallKind =
    | "turn"
    | "summarize"
    | "title"
    | "memory"
    | "webSearch"
    | "webFetch";

export interface UsageRecord {
    readonly ts: string;
    readonly sessionId: string;
    readonly projectId: string;
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly callKind: UsageCallKind;
}

export interface ProviderModelTotals {
    readonly inputTokens: number;
    readonly outputTokens: number;
}

export interface UsageTotals {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number;
    readonly byProvider: Readonly<Record<string, ProviderModelTotals>>;
    readonly byModel: Readonly<Record<string, ProviderModelTotals>>;
}

export const emptyUsageTotals = (): UsageTotals => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    byProvider: {},
    byModel: {},
});

const isNotFoundError = (err: unknown): boolean =>
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";

interface RawRecord {
    inputTokens?: unknown;
    outputTokens?: unknown;
    cacheReadTokens?: unknown;
    cacheCreationTokens?: unknown;
    provider?: unknown;
    model?: unknown;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const appendUsageRecord = async (
    rec: Omit<UsageRecord, "ts"> & { ts?: string },
): Promise<void> => {
    if (rec.inputTokens === 0 && rec.outputTokens === 0) return;
    const entry: UsageRecord = {
        ts: rec.ts ?? new Date().toISOString(),
        sessionId: rec.sessionId,
        projectId: rec.projectId,
        provider: rec.provider,
        model: rec.model,
        inputTokens: rec.inputTokens,
        outputTokens: rec.outputTokens,
        ...(rec.cacheReadTokens !== undefined ? { cacheReadTokens: rec.cacheReadTokens } : {}),
        ...(rec.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: rec.cacheCreationTokens }
            : {}),
        callKind: rec.callKind,
    };
    await mkdir(dirname(USAGE_FILE), { recursive: true });
    await appendFile(USAGE_FILE, `${JSON.stringify(entry)}\n`);
};

export const loadUsageTotals = async (): Promise<UsageTotals> => {
    let raw: string;
    try {
        raw = await readFile(USAGE_FILE, "utf8");
    } catch (err) {
        if (isNotFoundError(err)) return emptyUsageTotals();
        throw err;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    const byProvider: Record<string, { inputTokens: number; outputTokens: number }> = {};
    const byModel: Record<string, { inputTokens: number; outputTokens: number }> = {};

    for (const line of raw.split("\n")) {
        if (line.length === 0) continue;
        let parsed: RawRecord;
        try {
            parsed = JSON.parse(line) as RawRecord;
        } catch {
            continue;
        }
        const inT = num(parsed.inputTokens);
        const outT = num(parsed.outputTokens);
        inputTokens += inT;
        outputTokens += outT;
        cacheReadTokens += num(parsed.cacheReadTokens);
        cacheCreationTokens += num(parsed.cacheCreationTokens);
        if (typeof parsed.provider === "string" && parsed.provider.length > 0) {
            const cur = byProvider[parsed.provider] ?? { inputTokens: 0, outputTokens: 0 };
            byProvider[parsed.provider] = {
                inputTokens: cur.inputTokens + inT,
                outputTokens: cur.outputTokens + outT,
            };
        }
        if (typeof parsed.model === "string" && parsed.model.length > 0) {
            const cur = byModel[parsed.model] ?? { inputTokens: 0, outputTokens: 0 };
            byModel[parsed.model] = {
                inputTokens: cur.inputTokens + inT,
                outputTokens: cur.outputTokens + outT,
            };
        }
    }

    return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        byProvider,
        byModel,
    };
};
