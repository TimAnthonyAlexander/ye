import { getBackgroundManager } from "../tools/bash/background.ts";
import { getBackgroundSubagentManager } from "../subagents/background.ts";

const POLL_INTERVAL_MS = 500;

export type BackgroundKind = "bash" | "subagent";

// The wakeup prompts double as instructions: the completed result is injected
// into history right after this message, so the model must be told it already
// has it — an earlier version said "check its output" and the model answered by
// calling TaskOutput.
export const WAKEUP_REMINDERS: Readonly<Record<BackgroundKind, string>> = {
    bash: "<system-reminder>A background bash task finished. Its full output is included below — you already have it, so do not call BashOutput to fetch it.</system-reminder>",
    subagent:
        "<system-reminder>A background subagent finished. Its summary is included below — you already have it, so do not call TaskOutput to fetch it.</system-reminder>",
};

export const anyBackgroundRunning = (sessionId: string): boolean =>
    getBackgroundManager(sessionId).hasRunning() ||
    getBackgroundSubagentManager(sessionId).hasRunning();

// Resolves as soon as EITHER a background bash task or a background subagent has
// a result waiting. Awaiting the two managers in sequence instead would pin a
// finished subagent behind an unrelated long-running shell command — the
// subagent's wakeup could not fire until the build it had nothing to do with
// completed. Rejects when the signal aborts (user typed something).
export const waitForAnyBackgroundCompletion = (
    sessionId: string,
    signal: AbortSignal,
): Promise<BackgroundKind> =>
    new Promise<BackgroundKind>((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error("aborted"));
            return;
        }
        const settle = (fn: () => void): void => {
            clearInterval(interval);
            signal.removeEventListener("abort", onAbort);
            fn();
        };
        const onAbort = (): void => settle(() => reject(new Error("aborted")));
        signal.addEventListener("abort", onAbort, { once: true });
        const interval = setInterval(() => {
            if (getBackgroundSubagentManager(sessionId).hasUndelivered()) {
                settle(() => resolve("subagent"));
                return;
            }
            if (getBackgroundManager(sessionId).hasUndelivered()) {
                settle(() => resolve("bash"));
            }
        }, POLL_INTERVAL_MS);
        interval.unref?.();
    });
