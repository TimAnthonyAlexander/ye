import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { computeCostUsd } from "../providers/pricing.ts";
import { USAGE_FILE } from "./paths.ts";

export type UsageCallKind =
    | "turn"
    | "summarize"
    | "title"
    | "memory"
    | "webSearch"
    | "webFetch"
    | "suggestion";

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
    readonly costUsd?: number;
    readonly callKind: UsageCallKind;
}

export interface ProviderModelTotals {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly costUsd: number;
}

export interface UsageTotals {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number;
    readonly costUsd: number;
    readonly calls: number;
    readonly byProvider: Readonly<Record<string, ProviderModelTotals>>;
    readonly byModel: Readonly<Record<string, ProviderModelTotals>>;
}

export const emptyUsageTotals = (): UsageTotals => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    calls: 0,
    byProvider: {},
    byModel: {},
});

export interface UsageWindows {
    readonly day: UsageTotals;
    readonly week: UsageTotals;
    readonly allTime: UsageTotals;
}

export interface CallKindTotals {
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number;
    readonly costUsd: number;
}

export interface SessionUsage {
    readonly totals: CallKindTotals;
    readonly byCallKind: Readonly<Record<string, CallKindTotals>>;
}

const emptyCallKindTotals = (): CallKindTotals => ({
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
});

const isNotFoundError = (err: unknown): boolean =>
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";

interface RawRecord {
    ts?: unknown;
    sessionId?: unknown;
    callKind?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
    cacheReadTokens?: unknown;
    cacheCreationTokens?: unknown;
    costUsd?: unknown;
    provider?: unknown;
    model?: unknown;
}

interface ParsedRecord {
    readonly at: number;
    readonly sessionId: string;
    readonly callKind: string;
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number;
    readonly costUsd: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const parseRecords = (raw: string): readonly ParsedRecord[] => {
    const out: ParsedRecord[] = [];
    for (const line of raw.split("\n")) {
        if (line.length === 0) continue;
        let parsed: RawRecord;
        try {
            parsed = JSON.parse(line) as RawRecord;
        } catch {
            continue;
        }
        out.push({
            at: typeof parsed.ts === "string" ? Date.parse(parsed.ts) : Number.NaN,
            sessionId: str(parsed.sessionId),
            callKind: typeof parsed.callKind === "string" ? parsed.callKind : "turn",
            provider: str(parsed.provider),
            model: str(parsed.model),
            inputTokens: num(parsed.inputTokens),
            outputTokens: num(parsed.outputTokens),
            cacheReadTokens: num(parsed.cacheReadTokens),
            cacheCreationTokens: num(parsed.cacheCreationTokens),
            costUsd: num(parsed.costUsd),
        });
    }
    return out;
};

interface Bucket {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    calls: number;
    byProvider: Record<string, ProviderModelTotals>;
    byModel: Record<string, ProviderModelTotals>;
}

const newBucket = (): Bucket => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    calls: 0,
    byProvider: {},
    byModel: {},
});

const addKeyed = (
    map: Record<string, ProviderModelTotals>,
    key: string,
    rec: ParsedRecord,
): void => {
    if (key.length === 0) return;
    const cur = map[key] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
    map[key] = {
        inputTokens: cur.inputTokens + rec.inputTokens,
        outputTokens: cur.outputTokens + rec.outputTokens,
        cacheReadTokens: cur.cacheReadTokens + rec.cacheReadTokens,
        costUsd: cur.costUsd + rec.costUsd,
    };
};

const addToBucket = (bucket: Bucket, rec: ParsedRecord): void => {
    bucket.inputTokens += rec.inputTokens;
    bucket.outputTokens += rec.outputTokens;
    bucket.cacheReadTokens += rec.cacheReadTokens;
    bucket.cacheCreationTokens += rec.cacheCreationTokens;
    bucket.costUsd += rec.costUsd;
    bucket.calls += 1;
    addKeyed(bucket.byProvider, rec.provider, rec);
    addKeyed(bucket.byModel, rec.model, rec);
};

const sealBucket = (bucket: Bucket): UsageTotals => ({
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    cacheCreationTokens: bucket.cacheCreationTokens,
    costUsd: bucket.costUsd,
    calls: bucket.calls,
    byProvider: bucket.byProvider,
    byModel: bucket.byModel,
});

export const appendUsageRecord = async (
    rec: Omit<UsageRecord, "ts"> & { ts?: string },
): Promise<void> => {
    if (rec.inputTokens === 0 && rec.outputTokens === 0) return;
    // If the provider didn't supply cost (Anthropic / OpenAI direct), compute
    // it from the local pricing table. Unknown models → cost stays undefined
    // and the record is persisted without a cost field; totals skip it.
    const costUsd = rec.costUsd ?? computeCostUsd(rec.provider, rec.model, rec);
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
        ...(costUsd !== undefined ? { costUsd } : {}),
        callKind: rec.callKind,
    };
    await mkdir(dirname(USAGE_FILE), { recursive: true });
    await appendFile(USAGE_FILE, `${JSON.stringify(entry)}\n`);
};

const readUsageFile = async (): Promise<string> => {
    try {
        return await readFile(USAGE_FILE, "utf8");
    } catch (err) {
        if (isNotFoundError(err)) return "";
        throw err;
    }
};

// Same file, same records as loadUsageTotals — narrowed to one session and
// split by callKind so /cost can show where a session's spend went.
export const loadSessionUsage = async (sessionId: string): Promise<SessionUsage> => {
    let totals = emptyCallKindTotals();
    const byCallKind: Record<string, CallKindTotals> = {};

    for (const rec of parseRecords(await readUsageFile())) {
        if (rec.sessionId !== sessionId) continue;
        const add = (cur: CallKindTotals): CallKindTotals => ({
            calls: cur.calls + 1,
            inputTokens: cur.inputTokens + rec.inputTokens,
            outputTokens: cur.outputTokens + rec.outputTokens,
            cacheReadTokens: cur.cacheReadTokens + rec.cacheReadTokens,
            cacheCreationTokens: cur.cacheCreationTokens + rec.cacheCreationTokens,
            costUsd: cur.costUsd + rec.costUsd,
        });
        totals = add(totals);
        byCallKind[rec.callKind] = add(byCallKind[rec.callKind] ?? emptyCallKindTotals());
    }

    return { totals, byCallKind };
};

export const loadUsageTotals = async (): Promise<UsageTotals> => {
    const bucket = newBucket();
    for (const rec of parseRecords(await readUsageFile())) addToBucket(bucket, rec);
    return sealBucket(bucket);
};

const DAY_MS = 24 * 60 * 60 * 1000;

// A record whose timestamp is unparseable still counts towards all time — it
// happened, we just can't place it on the clock — but it can't claim a window.
export const aggregateUsageWindows = (raw: string, now: number): UsageWindows => {
    const day = newBucket();
    const week = newBucket();
    const allTime = newBucket();
    for (const rec of parseRecords(raw)) {
        addToBucket(allTime, rec);
        if (Number.isNaN(rec.at)) continue;
        const age = now - rec.at;
        if (age < DAY_MS) addToBucket(day, rec);
        if (age < 7 * DAY_MS) addToBucket(week, rec);
    }
    return { day: sealBucket(day), week: sealBucket(week), allTime: sealBucket(allTime) };
};

export const loadUsageWindows = async (now: number = Date.now()): Promise<UsageWindows> =>
    aggregateUsageWindows(await readUsageFile(), now);
