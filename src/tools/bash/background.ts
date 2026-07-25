import type { Subprocess } from "bun";
import { killGroupHard } from "./kill.ts";

const OUTPUT_CAP = 32_000;

const truncate = (text: string): string =>
    text.length > OUTPUT_CAP
        ? `${text.slice(0, OUTPUT_CAP)}\n…(truncated, ${text.length - OUTPUT_CAP} more chars)`
        : text;

export const formatBashResult = (
    stdout: string,
    stderr: string,
    exitCode: number,
    durationMs: number,
): string => {
    const body: string[] = [];
    if (stdout.length > 0) body.push(stdout);
    if (stderr.length > 0) body.push(`<stderr>\n${stderr}\n</stderr>`);
    // A closing </bash> tag (and an explicit note when there was no output)
    // makes the block unambiguously COMPLETE — a blocking command that printed
    // nothing must never read as still-running.
    if (body.length === 0) body.push("(command completed with no output)");
    return `<bash exit_code="${exitCode}" duration_ms="${durationMs}">\n${body.join("\n")}\n</bash>`;
};

// Completion notice for a terminal background task. A killed or timed-out task
// has no exit code, so it gets a plain partial-output body instead of a
// <bash exit_code="…"> block that would imply the command ran and failed.
export const formatBackgroundNotice = (task: BackgroundTask, durationMs: number): string => {
    const body =
        task.exitCode === null
            ? `${task.stdout}${task.stderr ? `\n<stderr>\n${task.stderr}\n</stderr>` : ""}`
            : formatBashResult(task.stdout, task.stderr, task.exitCode, durationMs);
    let headline: string;
    if (task.timedOut) {
        headline = `Background task ${task.id} was killed after hitting its timeout at ${durationMs}ms and did not complete — the output below is partial and there is no exit code.`;
    } else if (task.status === "killed") {
        headline = `Background task ${task.id} was killed after ${durationMs}ms before it completed — the output below is partial and there is no exit code.`;
    } else {
        headline = `Background task ${task.id} finished after ${durationMs}ms.`;
    }
    return `${headline}\nCommand: ${task.command}\n${body}`;
};

export interface BackgroundTask {
    readonly id: string;
    readonly command: string;
    readonly toolCallId: string;
    status: "running" | "completed" | "failed" | "killed";
    stdout: string;
    stderr: string;
    exitCode: number | null;
    // Distinguishes a timeout kill from a command that exited non-zero on its
    // own, so the completion notice can say which happened instead of inventing
    // an exit code.
    timedOut: boolean;
    delivered: boolean;
    readonly startedAt: number;
}

class BackgroundTaskManager {
    private readonly tasks = new Map<string, BackgroundTask>();
    // Live process handles and timeout timers, kept out of BackgroundTask so the
    // task stays a plain data record. Both are needed to actually stop a task:
    // without the handle, kill() could only ever set a status flag.
    private readonly procs = new Map<string, Subprocess>();
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private counter = 0;

    start(command: string, cwd: string, timeoutMs: number, toolCallId: string): string {
        const id = `bash-${++this.counter}`;
        const task: BackgroundTask = {
            id,
            command,
            toolCallId,
            status: "running",
            stdout: "",
            stderr: "",
            exitCode: null,
            timedOut: false,
            delivered: false,
            startedAt: Date.now(),
        };
        this.tasks.set(id, task);

        const shellCmd =
            process.platform === "win32"
                ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
                : ["sh", "-c", command];

        const proc: Subprocess = Bun.spawn({
            cmd: shellCmd,
            cwd,
            stdout: "pipe",
            stderr: "pipe",
            // New process group so `&`-backgrounded grandchildren die with the
            // shell when we signal -pid. POSIX only — on Windows `detached`
            // opens a separate console and detaches stdio, losing piped output.
            detached: process.platform !== "win32",
        });
        this.procs.set(id, proc);

        void (async () => {
            const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
            const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
            const stdoutReader = stdoutStream.getReader();
            const stderrReader = stderrStream.getReader();
            const decoder = new TextDecoder();

            // Append straight onto the task as bytes arrive. Buffering locally
            // and assigning once at exit would leave task.stdout empty for the
            // whole run, making a running task's partial output unreadable.
            const readLoop = async (
                reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
                append: (text: string) => void,
            ): Promise<void> => {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    append(decoder.decode(value, { stream: true }));
                }
            };

            await Promise.all([
                readLoop(stdoutReader, (text) => {
                    task.stdout = truncate(task.stdout + text);
                }),
                readLoop(stderrReader, (text) => {
                    task.stderr = truncate(task.stderr + text);
                }),
            ]);

            const exitCode = await proc.exited;
            this.clearTimer(id);
            this.procs.delete(id);
            // A killed or timed-out task has already reached its terminal state.
            // The process exiting afterwards must not resurrect it as completed.
            if (task.status !== "running") return;
            task.exitCode = exitCode;
            task.status = exitCode === 0 ? "completed" : "failed";
        })();

        if (timeoutMs > 0) {
            const timer = setTimeout(() => {
                this.timers.delete(id);
                if (task.status !== "running") return;
                killGroupHard(proc);
                task.status = "failed";
                task.exitCode = null;
                task.timedOut = true;
                task.stdout = truncate(`${task.stdout}\n[background task timed out]`);
                task.stderr = truncate(`${task.stderr}\ncommand timed out after ${timeoutMs}ms`);
            }, timeoutMs);
            timer.unref?.();
            this.timers.set(id, timer);
        }

        return id;
    }

    poll(id: string): BackgroundTask | undefined {
        return this.tasks.get(id);
    }

    kill(id: string): boolean {
        const task = this.tasks.get(id);
        if (!task || task.status !== "running") return false;
        task.status = "killed";
        task.exitCode = null;
        this.stopProcess(id);
        return true;
    }

    // Signal the real process group and drop the handle. Without this, "killed"
    // was a status flag only: the command kept running with the user's
    // privileges, kept appending output, and outlived the session.
    private stopProcess(id: string): void {
        this.clearTimer(id);
        const proc = this.procs.get(id);
        if (!proc) return;
        this.procs.delete(id);
        killGroupHard(proc);
    }

    private clearTimer(id: string): void {
        const timer = this.timers.get(id);
        if (timer === undefined) return;
        clearTimeout(timer);
        this.timers.delete(id);
    }

    drainCompleted(): BackgroundTask[] {
        const completed: BackgroundTask[] = [];
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
    // finished task without consuming it.
    hasUndelivered(): boolean {
        for (const task of this.tasks.values()) {
            if (!task.delivered && task.status !== "running") return true;
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
    waitForCompletion(signal: AbortSignal): Promise<BackgroundTask> {
        return new Promise<BackgroundTask>((resolve, reject) => {
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
                this.stopProcess(task.id);
            }
        }
        for (const id of [...this.timers.keys()]) this.clearTimer(id);
        this.tasks.clear();
        this.procs.clear();
    }
}

const managers = new Map<string, BackgroundTaskManager>();

export const getBackgroundManager = (sessionId: string): BackgroundTaskManager => {
    let mgr = managers.get(sessionId);
    if (!mgr) {
        mgr = new BackgroundTaskManager();
        managers.set(sessionId, mgr);
    }
    return mgr;
};

export const destroyBackgroundManager = (sessionId: string): void => {
    const mgr = managers.get(sessionId);
    if (mgr) {
        mgr.cleanup();
        managers.delete(sessionId);
    }
};
