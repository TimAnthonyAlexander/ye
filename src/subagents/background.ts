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
    abortController: AbortController | null;
}

class BackgroundSubagentManager {
    private readonly tasks = new Map<string, BackgroundSubagentTask>();
    private counter = 0;

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
            abortController: null,
        };
        this.tasks.set(id, task);

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

    runningCount(): number {
        let count = 0;
        for (const task of this.tasks.values()) {
            if (task.status === "running") count += 1;
        }
        return count;
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
