import type { Subprocess } from "bun";

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
    const sections = [`<bash exit_code="${exitCode}" duration_ms="${durationMs}">`];
    if (stdout.length > 0) sections.push(stdout);
    if (stderr.length > 0) sections.push(`<stderr>\n${stderr}\n</stderr>`);
    return sections.join("\n");
};

export interface BackgroundTask {
    readonly id: string;
    readonly command: string;
    readonly toolCallId: string;
    status: "running" | "completed" | "failed" | "killed";
    stdout: string;
    stderr: string;
    exitCode: number | null;
    delivered: boolean;
    readonly startedAt: number;
}

class BackgroundTaskManager {
    private readonly tasks = new Map<string, BackgroundTask>();
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
        });

        void (async () => {
            const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
            const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
            const stdoutReader = stdoutStream.getReader();
            const stderrReader = stderrStream.getReader();
            const decoder = new TextDecoder();

            const readLoop = async (
                reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
                buf: { value: string },
            ): Promise<void> => {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf.value += decoder.decode(value, { stream: true });
                    buf.value = truncate(buf.value);
                }
            };

            const stdoutBuf = { value: "" };
            const stderrBuf = { value: "" };

            await Promise.all([
                readLoop(stdoutReader, stdoutBuf),
                readLoop(stderrReader, stderrBuf),
            ]);

            const exitCode = await proc.exited;
            task.stdout = stdoutBuf.value;
            task.stderr = stderrBuf.value;
            task.exitCode = exitCode;
            task.status = exitCode === 0 ? "completed" : "failed";
        })();

        if (timeoutMs > 0) {
            setTimeout(() => {
                if (task.status === "running") {
                    try {
                        proc.kill();
                    } catch {
                        /* already dead */
                    }
                    task.status = "failed";
                    task.exitCode = null;
                    task.stdout += "\n[background task timed out]";
                    task.stderr += `\ncommand timed out after ${timeoutMs}ms`;
                    task.stdout = truncate(task.stdout);
                    task.stderr = truncate(task.stderr);
                }
            }, timeoutMs);
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
        return true;
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
            }
        }
        this.tasks.clear();
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
