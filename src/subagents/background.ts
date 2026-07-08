import type { SpawnContext } from "./index.ts";
import { runInProcess } from "./isolate/inProcess.ts";
import { EXPLORE_TOOLS, exploreSystemPrompt, exploreTurnBudget } from "./kinds/explore.ts";
import { GENERAL_TOOLS, generalSystemPrompt, generalTurnBudget } from "./kinds/general.ts";
import {
    VERIFICATION_TOOLS,
    verificationSystemPrompt,
    verificationTurnBudget,
} from "./kinds/verification.ts";
import type { SubagentKind, SubagentResult, SubagentSpec } from "./types.ts";
import type { Event } from "../pipeline/events.ts";

export interface SubagentToolItem {
    readonly kind: "tool";
    readonly id: string;
    readonly name: string;
    readonly args: unknown;
    status: "running" | "done" | "error";
    progress?: readonly string[];
}

export interface SubagentTextItem {
    readonly kind: "text";
    readonly id: string;
    readonly content: string;
}

export type SubagentItem = SubagentToolItem | SubagentTextItem;

let itemSeq = 0;
const nextItemId = (): string => `sa-${++itemSeq}`;

const MAX_ITEMS = 200;

// Backstop watchdog: if a running subagent emits no events for this long it is
// presumed dead and force-failed, so it can never stay "running" forever (which
// would leave the parent waiting on a ghost). The threshold sits above the
// longest legitimate silence — a single foreground tool call (Bash caps at
// 900s) — so active work is never false-killed. The provider-stream stall
// timeout in dispatch.ts is the fast, precise path; this only catches the rare
// non-stream hang.
const SUBAGENT_STALL_TIMEOUT_MS = 20 * 60 * 1000;
const SUBAGENT_SWEEP_INTERVAL_MS = 30 * 1000;

export interface BackgroundSubagentTask {
    readonly id: string;
    readonly kind: SubagentKind;
    readonly prompt: string;
    status: "running" | "completed" | "failed" | "killed";
    summary: string;
    transcriptPath: string;
    turnCount: number;
    error: string;
    delivered: boolean;
    readonly startedAt: number;
    // Updated on every child event; the watchdog fails a task whose activity
    // has gone silent past SUBAGENT_STALL_TIMEOUT_MS.
    lastActivityAt: number;
    abortController: AbortController | null;
    readonly items: SubagentItem[];
}

class BackgroundSubagentManager {
    private readonly tasks = new Map<string, BackgroundSubagentTask>();
    private counter = 0;
    private sweepTimer: ReturnType<typeof setInterval> | null = null;

    start(spec: SubagentSpec, ctx: SpawnContext): string {
        const id = `subagent-${++this.counter}`;
        const task: BackgroundSubagentTask = {
            id,
            kind: spec.kind,
            prompt: spec.prompt,
            status: "running",
            summary: "",
            transcriptPath: "",
            turnCount: 0,
            error: "",
            delivered: false,
            startedAt: Date.now(),
            lastActivityAt: Date.now(),
            abortController: null,
            items: [],
        };
        this.tasks.set(id, task);
        this.ensureSweep();

        const subagentBudget = ctx.config.maxTurns?.subagent ?? 25;
        let systemPrompt: string;
        let allowedTools: readonly string[];
        let maxTurns: number;
        switch (spec.kind) {
            case "explore": {
                const budget = Math.min(
                    exploreTurnBudget(spec.options?.thoroughness),
                    subagentBudget,
                );
                systemPrompt = exploreSystemPrompt(ctx.parentProjectRoot);
                allowedTools = EXPLORE_TOOLS;
                maxTurns = budget;
                break;
            }
            case "general": {
                systemPrompt = generalSystemPrompt(ctx.parentProjectRoot);
                allowedTools = GENERAL_TOOLS;
                maxTurns = Math.min(generalTurnBudget, subagentBudget);
                break;
            }
            case "verification": {
                systemPrompt = verificationSystemPrompt(ctx.parentProjectRoot);
                allowedTools = VERIFICATION_TOOLS;
                maxTurns = Math.min(verificationTurnBudget, subagentBudget);
                break;
            }
        }

        const abort = new AbortController();
        task.abortController = abort;

        let textBuf = "";
        const flushText = (): void => {
            if (textBuf.length === 0) return;
            task.items.push({
                kind: "text",
                id: nextItemId(),
                content: textBuf,
            });
            if (task.items.length > MAX_ITEMS) task.items.shift();
            textBuf = "";
        };

        const onChildEvent = (evt: Event): void => {
            task.lastActivityAt = Date.now();
            switch (evt.type) {
                case "model.text":
                    textBuf += evt.delta;
                    return;
                case "tool.start":
                    flushText();
                    task.items.push({
                        kind: "tool",
                        id: evt.id,
                        name: evt.name,
                        args: evt.args,
                        status: "running",
                    });
                    if (task.items.length > MAX_ITEMS) task.items.shift();
                    return;
                case "tool.end": {
                    flushText();
                    for (let i = task.items.length - 1; i >= 0; i--) {
                        const item = task.items[i];
                        if (item?.kind === "tool" && item.id === evt.id) {
                            item.status = evt.result.ok ? "done" : "error";
                            // Append the formatted line as post-label
                            return;
                        }
                    }
                    // Orphan tool.end — create a done item.
                    task.items.push({
                        kind: "tool",
                        id: evt.id,
                        name: evt.name,
                        args: {},
                        status: evt.result.ok ? "done" : "error",
                    });
                    if (task.items.length > MAX_ITEMS) task.items.shift();
                    return;
                }
                case "tool.progress":
                    for (let i = task.items.length - 1; i >= 0; i--) {
                        const item = task.items[i];
                        if (item?.kind === "tool" && item.id === evt.id) {
                            item.progress = evt.lines;
                            return;
                        }
                    }
                    return;
                case "turn.start":
                    flushText();
                    return;
                default:
                    return;
            }
        };

        void runInProcess({
            parentProjectId: ctx.parentProjectId,
            parentProjectRoot: ctx.parentProjectRoot,
            parentSessionId: ctx.parentSessionId,
            contextWindow: ctx.contextWindow,
            prompt: spec.prompt,
            systemPrompt,
            allowedTools,
            maxTurns,
            config: ctx.config,
            provider: ctx.provider,
            signal: abort.signal,
            onChildEvent,
        })
            .then((result: SubagentResult) => {
                task.summary = result.summary;
                task.transcriptPath = result.transcriptPath;
                task.turnCount = result.turnCount;
                task.status = "completed";
            })
            .catch((err: unknown) => {
                task.status = "failed";
                task.error = err instanceof Error ? err.message : String(err);
            });

        return id;
    }

    poll(id: string): BackgroundSubagentTask | undefined {
        return this.tasks.get(id);
    }

    kill(id: string): boolean {
        const task = this.tasks.get(id);
        if (!task || task.status !== "running") return false;
        task.status = "killed";
        task.abortController?.abort();
        return true;
    }

    drainCompleted(): BackgroundSubagentTask[] {
        const completed: BackgroundSubagentTask[] = [];
        for (const task of this.tasks.values()) {
            if (!task.delivered && task.status !== "running") {
                completed.push(task);
                task.delivered = true;
            }
        }
        return completed;
    }

    hasRunning(): boolean {
        for (const task of this.tasks.values()) {
            if (task.status === "running") return true;
        }
        return false;
    }

    allTasks(): IterableIterator<BackgroundSubagentTask> {
        return this.tasks.values();
    }

    runningCount(): number {
        let count = 0;
        for (const task of this.tasks.values()) {
            if (task.status === "running") count += 1;
        }
        return count;
    }

    // Lazily arm the watchdog when the first task starts. It self-clears once no
    // task is running, so it never lingers.
    private ensureSweep(): void {
        if (this.sweepTimer !== null) return;
        this.sweepTimer = setInterval(() => this.sweepStalled(), SUBAGENT_SWEEP_INTERVAL_MS);
        this.sweepTimer.unref?.();
    }

    private sweepStalled(): void {
        const now = Date.now();
        for (const task of this.tasks.values()) {
            if (
                task.status === "running" &&
                now - task.lastActivityAt > SUBAGENT_STALL_TIMEOUT_MS
            ) {
                task.status = "failed";
                task.error = `subagent produced no activity for ${Math.round(
                    SUBAGENT_STALL_TIMEOUT_MS / 60000,
                )} minutes and is presumed dead`;
                task.abortController?.abort();
            }
        }
        if (this.sweepTimer !== null && !this.hasRunning()) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }

    // Returns a promise that resolves with the completed task when any running
    // task finishes. Polls every 500ms. Rejects if the signal is aborted.
    waitForCompletion(signal: AbortSignal): Promise<BackgroundSubagentTask> {
        return new Promise<BackgroundSubagentTask>((resolve, reject) => {
            if (signal.aborted) {
                reject(new Error("aborted"));
                return;
            }
            const onAbort = (): void => {
                clearInterval(interval);
                reject(new Error("aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            const interval = setInterval(() => {
                for (const task of this.tasks.values()) {
                    if (!task.delivered && task.status !== "running") {
                        clearInterval(interval);
                        signal.removeEventListener("abort", onAbort);
                        resolve(task);
                        return;
                    }
                }
            }, 500);
        });
    }

    cleanup(): void {
        if (this.sweepTimer !== null) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        for (const task of this.tasks.values()) {
            if (task.status === "running") {
                task.status = "killed";
            }
        }
        this.tasks.clear();
    }
}

const managers = new Map<string, BackgroundSubagentManager>();

export const getBackgroundSubagentManager = (sessionId: string): BackgroundSubagentManager => {
    let mgr = managers.get(sessionId);
    if (!mgr) {
        mgr = new BackgroundSubagentManager();
        managers.set(sessionId, mgr);
    }
    return mgr;
};

export const destroyBackgroundSubagentManager = (sessionId: string): void => {
    const mgr = managers.get(sessionId);
    if (mgr) {
        mgr.cleanup();
        managers.delete(sessionId);
    }
};
