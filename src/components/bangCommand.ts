import { formatBashResult } from "../tools/bash/background.ts";

const MAX_OUTPUT = 32_000;
const DEFAULT_TIMEOUT_MS = 120_000;

// Platform-aware shell selection, mirroring src/tools/bash/index.ts. Kept local
// so the `!` input prefix stays independent of the Bash tool's turn machinery.
const shellCommand = (command: string): readonly string[] => {
    if (process.platform === "win32") {
        const comspec = process.env.ComSpec ?? "cmd.exe";
        return [comspec, "/d", "/s", "/c", command];
    }
    return ["sh", "-c", command];
};

const truncate = (s: string): string =>
    s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (truncated)` : s;

// Runs a one-off shell command for the `!` input prefix and returns the same
// formatted `<bash …>` block the model sees from the Bash tool. Never throws:
// spawn failures, aborts, and timeouts all render as a result block so the
// caller can display it and feed it to the model unconditionally.
export const runBangCommand = async (
    command: string,
    cwd: string,
    signal: AbortSignal,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> => {
    const startedAt = performance.now();
    try {
        const proc = Bun.spawn({
            cmd: [...shellCommand(command)],
            cwd,
            stdout: "pipe",
            stderr: "pipe",
            ...(process.platform !== "win32" ? { detached: true } : {}),
        });
        const killTimer = setTimeout(() => proc.kill(), timeoutMs);
        const onAbort = (): void => proc.kill();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            const [stdout, stderr] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
            ]);
            const exitCode = await proc.exited;
            const durationMs = Math.round(performance.now() - startedAt);
            return formatBashResult(truncate(stdout), truncate(stderr), exitCode, durationMs);
        } finally {
            clearTimeout(killTimer);
            signal.removeEventListener("abort", onAbort);
        }
    } catch (e) {
        const durationMs = Math.round(performance.now() - startedAt);
        return formatBashResult("", e instanceof Error ? e.message : String(e), 1, durationMs);
    }
};
