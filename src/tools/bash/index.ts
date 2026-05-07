import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface BashArgs {
    readonly command: string;
    readonly timeout?: number; // ms
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 900_000;
const OUTPUT_CAP = 32_000;
const KILL_GRACE_MS = 500;

interface BashOutput {
    stdout: string;
    stderr: string;
    exitCode: number;
}

const truncate = (text: string): string =>
    text.length > OUTPUT_CAP
        ? `${text.slice(0, OUTPUT_CAP)}\n…(truncated, ${text.length - OUTPUT_CAP} more chars)`
        : text;

// Kill the whole process group of a detached child. We use the negative-pid
// trick so backgrounded grandchildren (anything started with `&`) die with the
// shell, not just the immediate sh process. Falls back to a plain proc.kill if
// the group-kill throws (race with already-exited proc).
const killGroup = (proc: { pid: number; kill: (sig?: number) => void }, sig: NodeJS.Signals): void => {
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

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<BashOutput>> => {
    const v = validateArgs<BashArgs>(rawArgs, BashTool.schema);
    if (!v.ok) return v;
    const command = v.value.command;
    const timeoutMs = Math.min(v.value.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    const proc = Bun.spawn({
        cmd: ["sh", "-c", command],
        cwd: ctx.cwd,
        stdout: "pipe",
        stderr: "pipe",
        // New process group so backgrounded children get killed with the shell
        // when we send signals to -pid.
        detached: true,
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

    return {
        ok: true,
        value: {
            stdout: truncate(stdout),
            stderr: truncate(stderr),
            exitCode,
        },
    };
};

export const BashTool: Tool = {
    name: "Bash",
    description:
        "Execute a shell command via `sh -c`. Default 120s timeout, max 900s (15 min) via the optional `timeout` arg (ms). " +
        "Do NOT use this to start dev servers, watchers, or any command that runs indefinitely — those will hang the turn until timeout. " +
        "v1 has NO sandbox: in AUTO mode this command runs immediately with the user's privileges. " +
        "Prefer Read/Edit/Write/Glob/Grep over Bash when they fit.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["command"],
        properties: {
            command: { type: "string" },
            timeout: { type: "integer" },
        },
    },
    execute,
};
