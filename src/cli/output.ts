import type { Event } from "../pipeline/events.ts";

export const OUTPUT_FORMATS = ["text", "json", "stream-json"] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface RunUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedTokens: number;
    readonly costUsd: number;
}

export interface RunSummary {
    readonly ok: boolean;
    readonly result: string;
    readonly stopReason: string;
    readonly sessionId: string;
    readonly projectId: string;
    readonly model: string;
    readonly provider: string;
    readonly turns: number;
    readonly usage: RunUsage;
    readonly durationMs: number;
    readonly error?: string;
}

export const emptyRunUsage = (): RunUsage => ({
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
});

export const errorSummary = (error: string, extra: Partial<RunSummary> = {}): RunSummary => ({
    ok: false,
    result: "",
    stopReason: "error",
    sessionId: "",
    projectId: "",
    model: "",
    provider: "",
    turns: 0,
    usage: emptyRunUsage(),
    durationMs: 0,
    ...extra,
    error,
});

// Allowlist rather than a filter: the two prompt events carry `respond`
// callbacks, and anything added to the Event union later must be opted in
// deliberately instead of leaking onto a consumer's stdout.
const STREAMED: ReadonlySet<Event["type"]> = new Set<Event["type"]>([
    "turn.start",
    "turn.end",
    "model.text",
    "tool.start",
    "tool.end",
    "shaper.applied",
    "recovery.retry",
]);

// stdout is a machine contract here: a tool result that can't be stringified
// must degrade to a well-formed line, never break the stream.
const encode = (value: unknown): string | null => {
    try {
        return JSON.stringify(value);
    } catch {
        return null;
    }
};

export const streamEventLine = (event: Event): string | null => {
    if (!STREAMED.has(event.type)) return null;
    return encode(event) ?? `{"type":${JSON.stringify(event.type)}}`;
};

export const formatSummary = (format: OutputFormat, summary: RunSummary): string =>
    JSON.stringify(format === "stream-json" ? { type: "result", ...summary } : summary);

const write = (text: string): Promise<void> =>
    new Promise((resolve) => {
        process.stdout.write(text, () => resolve());
    });

export const writeStreamEvent = (event: Event): void => {
    const line = streamEventLine(event);
    if (line !== null) process.stdout.write(`${line}\n`);
};

// Awaits the write callback so an immediate process.exit() can't truncate the
// last line when stdout is a pipe.
export const writeSummary = async (format: OutputFormat, summary: RunSummary): Promise<void> => {
    if (format === "text") return;
    await write(`${formatSummary(format, summary)}\n`);
};
