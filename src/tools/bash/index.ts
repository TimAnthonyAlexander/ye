import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import { formatBashResult, getBackgroundManager } from "./background.ts";

interface BashArgs {
    readonly command: string;
    readonly timeout?: number; // ms
    readonly run_in_background?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 900_000;
const OUTPUT_CAP = 32_000;
const KILL_GRACE_MS = 500;

const truncate = (text: string): string =>
    text.length > OUTPUT_CAP
        ? `${text.slice(0, OUTPUT_CAP)}\n…(truncated, ${text.length - OUTPUT_CAP} more chars)`
        : text;

// Kill the whole process group of a detached child. We use the negative-pid
// trick so backgrounded grandchildren (anything started with `&`) die with the
// shell, not just the immediate sh process. Falls back to a plain proc.kill if
// the group-kill throws (race with already-exited proc).
const killGroup = (
    proc: { pid: number; kill: (sig?: number) => void },
    sig: NodeJS.Signals,
): void => {
    try {
        process.kill(-proc.pid, sig);
        return;
    } catch {
        // Process group already gone, or pid not a group leader — try direct.
    }
    try {
        proc.kill(sig === "SIGKILL" ? 9 : 15);
    } catch {
        // Already dead.
    }
};

// Race a promise against an abort signal. Resolves to "aborted" if the signal
// fires first; otherwise resolves/rejects with the original promise. Lets us
// stop awaiting hung pipe reads when the user cancels.
const raceAbort = <T>(p: Promise<T>, signal: AbortSignal): Promise<T | "aborted"> =>
    new Promise<T | "aborted">((resolve, reject) => {
        if (signal.aborted) {
            resolve("aborted");
            return;
        }
        let settled = false;
        const onAbort = (): void => {
            if (settled) return;
            settled = true;
            resolve("aborted");
        };
        signal.addEventListener("abort", onAbort, { once: true });
        p.then(
            (v) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", onAbort);
                resolve(v);
            },
            (e) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", onAbort);
                reject(e);
            },
        );
    });

// Pick the shell + invocation flag for the host platform. Bun's `sh` does not
// exist on Windows; use the comspec (cmd.exe) there. POSIX hosts get `sh -c`.
const shellCommand = (command: string): readonly string[] => {
    if (process.platform === "win32") {
        const comspec = process.env.ComSpec ?? "cmd.exe";
        return [comspec, "/d", "/s", "/c", command];
    }
    return ["sh", "-c", command];
};

const timeoutHint = (ms: number): string => {
    const next = Math.min(ms * 2, MAX_TIMEOUT_MS);
    return (
        `command timed out after ${ms}ms. ` +
        `Re-run with a larger \`timeout\` arg if the command is genuinely slow ` +
        `(max ${MAX_TIMEOUT_MS}ms / ${MAX_TIMEOUT_MS / 60_000} min — try ${next}). ` +
        `If the command runs indefinitely (dev server, watcher, daemon), do NOT retry; ` +
        `tell the user instead and let them run it themselves.`
    );
};

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<BashArgs>(rawArgs, BashTool.schema);
    if (!v.ok) return v;
    const command = v.value.command;
    const timeoutMs = Math.min(v.value.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    if (v.value.run_in_background) {
        const mgr = getBackgroundManager(ctx.sessionId);
        const id = mgr.start(command, ctx.cwd, timeoutMs, "");
        return {
            ok: true,
            value: `Background task started: ${id}\nCommand: ${command}\nUse BashOutput to check status, KillShell to stop it.`,
        };
    }

    const startedAt = performance.now();

    const proc = Bun.spawn({
        cmd: [...shellCommand(command)],
        cwd: ctx.cwd,
        stdout: "pipe",
        stderr: "pipe",
        // New process group so backgrounded children get killed with the shell
        // when we send signals to -pid. POSIX only — on Windows `detached` opens
        // a separate console window and detaches stdio, so piped output is lost.
        detached: process.platform !== "win32",
    });

    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
        timedOut = true;
        killGroup(proc, "SIGTERM");
        setTimeout(() => killGroup(proc, "SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);

    const onAbort = (): void => {
        aborted = true;
        killGroup(proc, "SIGTERM");
        setTimeout(() => killGroup(proc, "SIGKILL"), KILL_GRACE_MS);
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });

    const collectPromise = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);

    const collected = await raceAbort(collectPromise, ctx.signal);
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);

    if (collected === "aborted" || aborted) {
        // Pipes may still be open held by orphaned children we couldn't reach.
        // Don't await proc.exited — return immediately so the turn can move on.
        return { ok: false, error: "command aborted by user (Ctrl+C)" };
    }

    if (timedOut) {
        return { ok: false, error: timeoutHint(timeoutMs) };
    }

    const [stdout, stderr] = collected;
    const exitCode = await proc.exited;
    const durationMs = Math.round(performance.now() - startedAt);

    return {
        ok: true,
        value: formatBashResult(truncate(stdout), truncate(stderr), exitCode, durationMs),
    };
};

export const BashTool: Tool = {
    name: "Bash",
    description:
        "Execute a shell command via the system shell (`sh -c` on macOS/Linux, `cmd.exe /c` on Windows). Default 120s timeout, max 900s (15 min) via the optional `timeout` arg (ms). " +
        "Do NOT use this to start dev servers, watchers, or any command that runs indefinitely — those will hang the turn until timeout. " +
        "For long-running commands (builds, test suites, installs), set `run_in_background: true` to start the command as a background task and continue working while it runs. " +
        "When the background task finishes, you'll be notified at the start of your next turn. Use BashOutput to poll a running task's output, and KillShell to stop it. " +
        "v1 has NO sandbox: in AUTO mode this command runs immediately with the user's privileges. " +
        "Prefer Read/Edit/Write/Glob/Grep over Bash when they fit.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["command"],
        properties: {
            command: { type: "string" },
            timeout: { type: "integer" },
            run_in_background: { type: "boolean" },
        },
    },
    execute,
};
