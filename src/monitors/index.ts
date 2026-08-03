import type { Subprocess } from "bun";
import { killGroupHard } from "../tools/bash/kill.ts";

export interface MonitorSpec {
    readonly reason: string;
    readonly condition?: string;
    readonly capture?: string;
    readonly at?: string;
    readonly intervalSec?: number;
    readonly giveUpAfterSec?: number;
}

export type MonitorOutcome = "condition_met" | "time_reached" | "gave_up" | "broken" | "killed";

export interface MonitorTask {
    readonly id: string;
    readonly reason: string;
    readonly status: "running" | MonitorOutcome;
    readonly startedAt: number;
    readonly finishedAt?: number;
    readonly polls: number;
    readonly output: string;
    readonly error?: string;
}

export interface MonitorManager {
    start(spec: MonitorSpec, cwd: string): string;
    kill(id: string): boolean;
    list(): readonly MonitorTask[];
    runningCount(): number;
    drainCompleted(): readonly MonitorTask[];
    hasUndelivered(): boolean;
}

const OUTPUT_CAP = 32_000;
const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 5_000;
const DEFAULT_GIVE_UP_MS = 86_400_000;
const POLL_TIMEOUT_MS = 60_000;
const MAX_CONSECUTIVE_ERRORS = 3;

let minIntervalMs = MIN_INTERVAL_MS;
let pollTimeoutMs = POLL_TIMEOUT_MS;

export const _setMonitorTimings = (timings: {
    readonly intervalFloorMs?: number;
    readonly pollTimeoutMs?: number;
}): void => {
    if (timings.intervalFloorMs !== undefined) minIntervalMs = timings.intervalFloorMs;
    if (timings.pollTimeoutMs !== undefined) pollTimeoutMs = timings.pollTimeoutMs;
};

export const _resetMonitorTimings = (): void => {
    minIntervalMs = MIN_INTERVAL_MS;
    pollTimeoutMs = POLL_TIMEOUT_MS;
};

// The payload of a monitor is almost always a log tail, so the cap keeps the
// END of the output — the opposite of the bash tool, which keeps the head.
const capTail = (text: string): string =>
    text.length > OUTPUT_CAP
        ? `…(truncated, ${text.length - OUTPUT_CAP} earlier chars omitted)\n${text.slice(text.length - OUTPUT_CAP)}`
        : text;

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const resolveMonitorAt = (at: string, now: number): number => {
    const clock = HH_MM.exec(at);
    if (clock) {
        const target = new Date(now);
        target.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
        if (target.getTime() <= now) target.setDate(target.getDate() + 1);
        return target.getTime();
    }
    const parsed = Date.parse(at);
    if (Number.isNaN(parsed)) {
        throw new Error(`Monitor "at" is neither an ISO 8601 timestamp nor HH:MM: ${at}`);
    }
    return parsed;
};

const formatDuration = (ms: number): string => {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export const monitorCompletionNotice = (task: MonitorTask): string => {
    const elapsed = formatDuration((task.finishedAt ?? Date.now()) - task.startedAt);
    const head = `Monitor ${task.id} (${task.reason})`;
    const polls = `${task.polls} poll${task.polls === 1 ? "" : "s"}`;
    let headline: string;
    switch (task.status) {
        case "condition_met":
            headline = `${head} fired: OUTCOME condition_met — the condition became true after ${elapsed} and ${polls}. The captured output follows.`;
            break;
        case "time_reached":
            headline = `${head} fired: OUTCOME time_reached — the scheduled time arrived after ${elapsed}. The captured output follows.`;
            break;
        case "gave_up":
            headline = `${head} stopped: OUTCOME gave_up — it reached its give-up deadline after ${elapsed} and ${polls}, and the condition was NEVER true at any poll. This says nothing about the thing being waited on: it has not been observed to finish, fail, or make progress. Check it directly before drawing any conclusion.`;
            break;
        case "broken":
            headline = `${head} stopped: OUTCOME broken — the condition command failed ${MAX_CONSECUTIVE_ERRORS} times in a row, so the monitor could never tell whether the condition was true. Something is wrong with the command or the host it runs against, not necessarily with the thing being waited on.`;
            break;
        case "killed":
            headline = `${head} stopped: OUTCOME killed — it was killed after ${elapsed} and ${polls}, before any outcome was reached.`;
            break;
        default:
            headline = `${head} is still running after ${elapsed} and ${polls}.`;
    }
    const parts = [headline];
    if (task.output.length > 0) parts.push(task.output);
    if (task.error !== undefined) parts.push(`<stderr>\n${task.error}\n</stderr>`);
    return parts.join("\n");
};

type MonitorRecord = { -readonly [K in keyof MonitorTask]: MonitorTask[K] } & {
    delivered: boolean;
};

type PollResult =
    | { readonly kind: "met" }
    | { readonly kind: "not_yet" }
    | { readonly kind: "error"; readonly detail: string };

interface RunResult {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
}

const shellCmd = (command: string): string[] =>
    process.platform === "win32"
        ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
        : ["sh", "-c", command];

class Manager implements MonitorManager {
    private readonly records = new Map<string, MonitorRecord>();
    private readonly procs = new Map<string, Subprocess>();
    private readonly sleepers = new Map<
        string,
        { readonly timer: ReturnType<typeof setTimeout>; readonly resolve: () => void }
    >();
    private counter = 0;

    start(spec: MonitorSpec, cwd: string): string {
        if (spec.condition === undefined && spec.at === undefined) {
            throw new Error("A monitor needs a condition, an at time, or both.");
        }
        const atMs = spec.at === undefined ? undefined : resolveMonitorAt(spec.at, Date.now());
        const id = `monitor-${++this.counter}`;
        const record: MonitorRecord = {
            id,
            reason: spec.reason,
            status: "running",
            startedAt: Date.now(),
            polls: 0,
            output: "",
            delivered: false,
        };
        this.records.set(id, record);
        void this.run(record, spec, cwd, atMs);
        return id;
    }

    kill(id: string): boolean {
        const record = this.records.get(id);
        if (!record || record.status !== "running") return false;
        record.status = "killed";
        record.finishedAt = Date.now();
        this.stop(id);
        return true;
    }

    list(): readonly MonitorTask[] {
        return [...this.records.values()];
    }

    runningCount(): number {
        let count = 0;
        for (const record of this.records.values()) {
            if (record.status === "running") count += 1;
        }
        return count;
    }

    drainCompleted(): readonly MonitorTask[] {
        const done: MonitorRecord[] = [];
        for (const record of this.records.values()) {
            if (!record.delivered && record.status !== "running") {
                done.push(record);
                record.delivered = true;
            }
        }
        return done;
    }

    hasUndelivered(): boolean {
        for (const record of this.records.values()) {
            if (!record.delivered && record.status !== "running") return true;
        }
        return false;
    }

    cleanup(): void {
        for (const record of this.records.values()) {
            if (record.status === "running") {
                record.status = "killed";
                record.finishedAt = Date.now();
                this.stop(record.id);
            }
        }
        this.records.clear();
        this.procs.clear();
        this.sleepers.clear();
    }

    private async run(
        record: MonitorRecord,
        spec: MonitorSpec,
        cwd: string,
        atMs: number | undefined,
    ): Promise<void> {
        const requested =
            spec.intervalSec === undefined ? DEFAULT_INTERVAL_MS : spec.intervalSec * 1000;
        const intervalMs = Math.max(requested, minIntervalMs);
        const deadline =
            record.startedAt +
            (spec.giveUpAfterSec === undefined ? DEFAULT_GIVE_UP_MS : spec.giveUpAfterSec * 1000);
        let consecutiveErrors = 0;

        while (record.status === "running") {
            if (atMs !== undefined && Date.now() >= atMs) {
                await this.finish(record, "time_reached", spec, cwd);
                return;
            }

            if (spec.condition !== undefined) {
                const result = await this.poll(spec.condition, cwd, record.id);
                if (record.status !== "running") return;
                record.polls += 1;
                if (result.kind === "met") {
                    await this.finish(record, "condition_met", spec, cwd);
                    return;
                }
                if (result.kind === "error") {
                    consecutiveErrors += 1;
                    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                        record.output = `The condition command failed ${consecutiveErrors} times in a row and was never able to answer whether the condition holds.`;
                        record.error = result.detail;
                        this.terminate(record, "broken");
                        return;
                    }
                } else {
                    consecutiveErrors = 0;
                }
            }

            const now = Date.now();
            if (now >= deadline) {
                this.terminate(record, "gave_up");
                return;
            }
            // Sleeping a full interval past a scheduled time or the deadline
            // would report the outcome late by up to one interval.
            const wakeAt = Math.min(now + intervalMs, atMs ?? Infinity, deadline);
            await this.sleep(record.id, Math.max(0, wakeAt - now));
        }
    }

    private async poll(condition: string, cwd: string, id: string): Promise<PollResult> {
        const result = await this.spawn(condition, cwd, id);
        if (result.timedOut) {
            return {
                kind: "error",
                detail: `condition command timed out after ${pollTimeoutMs}ms`,
            };
        }
        if (result.exitCode === 0) return { kind: "met" };
        if (result.exitCode === 1) return { kind: "not_yet" };
        const stderr = result.stderr.trim();
        return {
            kind: "error",
            detail:
                stderr.length > 0
                    ? stderr
                    : `condition command exited ${result.exitCode ?? "without an exit code"}`,
        };
    }

    private async finish(
        record: MonitorRecord,
        outcome: "condition_met" | "time_reached",
        spec: MonitorSpec,
        cwd: string,
    ): Promise<void> {
        if (spec.capture !== undefined) {
            const result = await this.spawn(spec.capture, cwd, record.id);
            if (record.status !== "running") return;
            record.output = capTail(result.stdout);
            if (result.timedOut) {
                record.error = `capture command timed out after ${pollTimeoutMs}ms`;
            } else if (result.exitCode !== 0) {
                const stderr = result.stderr.trim();
                record.error =
                    stderr.length > 0
                        ? stderr
                        : `capture command exited ${result.exitCode ?? "without an exit code"}`;
            }
        }
        this.terminate(record, outcome);
    }

    private terminate(record: MonitorRecord, outcome: MonitorOutcome): void {
        if (record.status !== "running") return;
        record.status = outcome;
        record.finishedAt = Date.now();
        this.stop(record.id);
    }

    private async spawn(command: string, cwd: string, id: string): Promise<RunResult> {
        let proc: Subprocess;
        try {
            proc = Bun.spawn({
                cmd: shellCmd(command),
                cwd,
                stdout: "pipe",
                stderr: "pipe",
                detached: process.platform !== "win32",
            });
        } catch (err) {
            return {
                exitCode: null,
                stdout: "",
                stderr: err instanceof Error ? err.message : String(err),
                timedOut: false,
            };
        }
        this.procs.set(id, proc);

        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            killGroupHard(proc);
        }, pollTimeoutMs);
        timer.unref?.();

        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
            new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        ]);
        const exitCode = await proc.exited;
        clearTimeout(timer);
        this.procs.delete(id);
        return { exitCode: timedOut ? null : exitCode, stdout, stderr, timedOut };
    }

    // Wakeable sleep: a kill must stop the loop now, not one interval from now.
    private sleep(id: string, ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.sleepers.delete(id);
                resolve();
            }, ms);
            timer.unref?.();
            this.sleepers.set(id, { timer, resolve });
        });
    }

    private stop(id: string): void {
        const sleeper = this.sleepers.get(id);
        if (sleeper) {
            clearTimeout(sleeper.timer);
            this.sleepers.delete(id);
            sleeper.resolve();
        }
        const proc = this.procs.get(id);
        if (!proc) return;
        this.procs.delete(id);
        killGroupHard(proc);
    }
}

const managers = new Map<string, Manager>();

export const getMonitorManager = (sessionId: string): MonitorManager => {
    let mgr = managers.get(sessionId);
    if (!mgr) {
        mgr = new Manager();
        managers.set(sessionId, mgr);
    }
    return mgr;
};

export const destroyMonitorManager = (sessionId: string): void => {
    const mgr = managers.get(sessionId);
    if (mgr) {
        mgr.cleanup();
        managers.delete(sessionId);
    }
};
