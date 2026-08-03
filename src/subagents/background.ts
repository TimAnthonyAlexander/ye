import { resolveAgent } from "./catalogue.ts";
import { subagentBudgetFor, type SpawnContext } from "./index.ts";
import { runInProcess } from "./isolate/inProcess.ts";
import { SubagentMailbox, type EnqueueResult } from "./mailbox.ts";
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

// A steer the user typed in the transcript view, recorded at the point it was
// handed to the subagent so the transcript reads in delivery order.
export interface SubagentUserItem {
    readonly kind: "user";
    readonly id: string;
    readonly content: string;
}

export type SubagentItem = SubagentToolItem | SubagentTextItem | SubagentUserItem;

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
    // UI-driven steering inbox. Closed the moment the task leaves "running", so
    // a message typed at an agent that already finished is refused rather than
    // sitting in a queue nothing will ever read.
    readonly mailbox: SubagentMailbox;
}

type TerminalStatus = "completed" | "failed" | "killed";

const CLOSE_REASON: Readonly<Record<TerminalStatus, string>> = {
    completed: "the subagent already finished",
    failed: "the subagent failed",
    killed: "the subagent was stopped",
};

class BackgroundSubagentManager {
    private readonly tasks = new Map<string, BackgroundSubagentTask>();
    private counter = 0;
    private sweepTimer: ReturnType<typeof setInterval> | null = null;

    start(spec: SubagentSpec, ctx: SpawnContext): string {
        const id = `subagent-${++this.counter}`;

        const items: SubagentItem[] = [];
        const pushItem = (item: SubagentItem): void => {
            items.push(item);
            if (items.length > MAX_ITEMS) items.shift();
        };

        let textBuf = "";
        const flushText = (): void => {
            if (textBuf.length === 0) return;
            pushItem({ kind: "text", id: nextItemId(), content: textBuf });
            textBuf = "";
        };

        const mailbox = new SubagentMailbox({
            onDelivered: (message) => {
                flushText();
                pushItem({ kind: "user", id: message.id, content: message.text });
            },
        });

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
            items,
            mailbox,
        };
        this.tasks.set(id, task);
        this.ensureSweep();

        const resolved = resolveAgent(spec, ctx.parentProjectRoot, subagentBudgetFor(ctx.config));

        const abort = new AbortController();
        task.abortController = abort;

        const onChildEvent = (evt: Event): void => {
            task.lastActivityAt = Date.now();
            switch (evt.type) {
                case "model.text":
                    textBuf += evt.delta;
                    return;
                case "tool.start":
                    flushText();
                    pushItem({
                        kind: "tool",
                        id: evt.id,
                        name: evt.name,
                        args: evt.args,
                        status: "running",
                    });
                    return;
                case "tool.end": {
                    flushText();
                    for (let i = items.length - 1; i >= 0; i--) {
                        const item = items[i];
                        if (item?.kind === "tool" && item.id === evt.id) {
                            item.status = evt.result.ok ? "done" : "error";
                            // Append the formatted line as post-label
                            return;
                        }
                    }
                    // Orphan tool.end — create a done item.
                    pushItem({
                        kind: "tool",
                        id: evt.id,
                        name: evt.name,
                        args: {},
                        status: evt.result.ok ? "done" : "error",
                    });
                    return;
                }
                case "tool.progress":
                    for (let i = items.length - 1; i >= 0; i--) {
                        const item = items[i];
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
            prompt: resolved.userPrompt,
            systemPrompt: resolved.systemPrompt,
            allowedTools: resolved.allowedTools,
            maxTurns: resolved.maxTurns,
            seedHistory: resolved.seedHistory,
            config: ctx.config,
            provider: ctx.provider,
            signal: abort.signal,
            ...(resolved.model !== undefined ? { model: resolved.model } : {}),
            onChildEvent,
            mailbox,
        })
            .then((result: SubagentResult) => {
                task.summary = result.summary;
                task.transcriptPath = result.transcriptPath;
                task.turnCount = result.turnCount;
                this.settle(task, "completed");
            })
            .catch((err: unknown) => {
                task.error = err instanceof Error ? err.message : String(err);
                this.settle(task, "failed");
            });

        return id;
    }

    // Single exit for every terminal transition. The mailbox has to close on all
    // of them, and a status assignment scattered across five call sites is how
    // one of them would eventually be missed.
    private settle(task: BackgroundSubagentTask, status: TerminalStatus): void {
        task.status = status;
        task.mailbox.close(CLOSE_REASON[status]);
    }

    // UI-driven steering. Deliberately not reachable from any tool: the parent
    // already has Task, and a model-facing steering tool is a second way to do
    // the same thing.
    steer(id: string, text: string): EnqueueResult {
        const task = this.tasks.get(id);
        if (!task) return { ok: false, error: `no background subagent with id "${id}"` };
        return task.mailbox.enqueue(text);
    }

    poll(id: string): BackgroundSubagentTask | undefined {
        return this.tasks.get(id);
    }

    kill(id: string): boolean {
        const task = this.tasks.get(id);
        if (!task || task.status !== "running") return false;
        this.settle(task, "killed");
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

    // Non-mutating counterpart to drainCompleted, so a waiter can detect a
    // finished subagent without consuming it.
    hasUndelivered(): boolean {
        for (const task of this.tasks.values()) {
            if (!task.delivered && task.status !== "running") return true;
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
                task.error = `subagent produced no activity for ${Math.round(
                    SUBAGENT_STALL_TIMEOUT_MS / 60000,
                )} minutes and is presumed dead`;
                this.settle(task, "failed");
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
                this.settle(task, "killed");
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
