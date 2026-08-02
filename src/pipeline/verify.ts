import type { VerifyConfig } from "../config/types.ts";
import { killGroupHard } from "../tools/bash/kill.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 4_000;

// Two failed verifications get the model two more shots at a fix. Past that a
// model that cannot fix the error would loop on the same failure forever.
export const MAX_VERIFY_CONTINUATIONS = 2;

export type VerifyStep = "typecheck" | "lint" | "test";

// Cheapest signal first; the chain stops at the first failure.
const STEP_ORDER: readonly VerifyStep[] = ["typecheck", "lint", "test"];

export interface VerifyFailure {
    readonly step: VerifyStep;
    readonly command: string;
    readonly timedOut: boolean;
    readonly timeoutMs: number;
    readonly output: string;
}

export type VerifyOutcome =
    | { readonly kind: "passed" }
    | { readonly kind: "failed"; readonly failure: VerifyFailure };

interface ChainState {
    wroteFiles: boolean;
    continuations: number;
}

// Keyed by session, like the skill scope: a chain is every turn queryLoop runs
// for one user prompt, and turn.ts clears the entry when the chain ends.
const chains = new Map<string, ChainState>();

const chainFor = (sessionId: string): ChainState => {
    const existing = chains.get(sessionId);
    if (existing !== undefined) return existing;
    const fresh: ChainState = { wroteFiles: false, continuations: 0 };
    chains.set(sessionId, fresh);
    return fresh;
};

export const recordToolWrite = (sessionId: string, toolName: string, ok: boolean): void => {
    if (!ok) return;
    if (toolName !== "Edit" && toolName !== "Write") return;
    chainFor(sessionId).wroteFiles = true;
};

export const clearVerifyChain = (sessionId: string): void => {
    chains.delete(sessionId);
};

export const verifyContinuationsUsed = (sessionId: string): number =>
    chains.get(sessionId)?.continuations ?? 0;

export const useVerifyContinuation = (sessionId: string): boolean => {
    const chain = chainFor(sessionId);
    if (chain.continuations >= MAX_VERIFY_CONTINUATIONS) return false;
    chain.continuations += 1;
    return true;
};

const configuredSteps = (verify: VerifyConfig): readonly (readonly [VerifyStep, string])[] =>
    STEP_ORDER.flatMap((step) => {
        const command = verify[step];
        return command !== undefined && command.trim().length > 0 ? [[step, command] as const] : [];
    });

export const shouldVerify = (verify: VerifyConfig | undefined, sessionId: string): boolean => {
    if (verify?.enabled !== true) return false;
    if (configuredSteps(verify).length === 0) return false;
    return chains.get(sessionId)?.wroteFiles === true;
};

// Mirrors the Bash tool's shell selection: Bun's `sh` does not exist on Windows.
const shellCommand = (command: string): readonly string[] => {
    if (process.platform === "win32") {
        const comspec = process.env.ComSpec ?? "cmd.exe";
        return [comspec, "/d", "/s", "/c", command];
    }
    return ["sh", "-c", command];
};

// Errors cluster at the end of a compiler or test run, so drop the head.
const tail = (text: string): string =>
    text.length <= OUTPUT_CAP
        ? text
        : `…(${text.length - OUTPUT_CAP} earlier chars truncated)\n${text.slice(text.length - OUTPUT_CAP)}`;

type RunStatus = "ok" | "failed" | "timeout" | "aborted";

interface RunOutcome {
    readonly status: RunStatus;
    readonly output: string;
}

const runCommand = async (
    command: string,
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal,
): Promise<RunOutcome> => {
    if (signal.aborted) return { status: "aborted", output: "" };

    const proc = Bun.spawn({
        cmd: [...shellCommand(command)],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
    });

    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
        timedOut = true;
        killGroupHard(proc);
    }, timeoutMs);
    const onAbort = (): void => {
        aborted = true;
        killGroupHard(proc);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);

    const output = `${stdout}${stderr}`.trim();
    if (aborted) return { status: "aborted", output };
    if (timedOut) return { status: "timeout", output };
    return { status: exitCode === 0 ? "ok" : "failed", output };
};

export interface VerifyInput {
    readonly verify: VerifyConfig;
    readonly cwd: string;
    readonly signal: AbortSignal;
}

export const runVerification = async ({
    verify,
    cwd,
    signal,
}: VerifyInput): Promise<VerifyOutcome> => {
    const timeoutMs = verify.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (const [step, command] of configuredSteps(verify)) {
        const run = await runCommand(command, cwd, timeoutMs, signal);
        if (run.status === "ok" || run.status === "aborted") continue;
        return {
            kind: "failed",
            failure: {
                step,
                command,
                timedOut: run.status === "timeout",
                timeoutMs,
                output: tail(run.output),
            },
        };
    }
    return { kind: "passed" };
};

export const formatVerifyReminder = (failure: VerifyFailure, final: boolean): string => {
    const headline = failure.timedOut
        ? `\`${failure.command}\` (${failure.step}) TIMED OUT after ${failure.timeoutMs}ms — it never finished, so this is not a reported check failure.`
        : `\`${failure.command}\` (${failure.step}) failed.`;
    const closing = final
        ? `Verification has now failed ${MAX_VERIFY_CONTINUATIONS + 1} times and will not be retried automatically. Stop retrying and tell the user it is still failing.`
        : "Fix the cause, then finish. Verification runs again when you next stop.";
    const body = failure.output.length > 0 ? `Output (tail):\n${failure.output}\n` : "";
    return `<system-reminder>\nPost-edit verification: ${headline}\n${body}${closing}\n</system-reminder>`;
};
