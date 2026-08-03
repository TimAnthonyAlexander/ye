import { getBackgroundManager } from "../tools/bash/background.ts";
import { getBackgroundSubagentManager } from "../subagents/background.ts";
import { getMonitorManager } from "../monitors/index.ts";

const POLL_INTERVAL_MS = 500;

export type BackgroundKind = "bash" | "subagent" | "monitor";

// The wakeup prompts double as instructions: the completed result is injected
// into history right after this message, so the model must be told it already
// has it — an earlier version said "check its output" and the model answered by
// calling TaskOutput.
export const WAKEUP_REMINDERS: Readonly<Record<BackgroundKind, string>> = {
    bash: "<system-reminder>A background bash task finished. Its full output is included below — you already have it, so do not call BashOutput to fetch it.</system-reminder>",
    subagent:
        "<system-reminder>A background subagent finished. Its summary is included below — you already have it, so do not call TaskOutput to fetch it.</system-reminder>",
    monitor:
        "<system-reminder>A monitor stopped. Its outcome and captured output are included below — you already have them, so do not call Monitor to fetch them. Read the OUTCOME word before concluding anything: it describes what the monitor observed, not the state of the thing being watched.</system-reminder>",
};

const KINDS: readonly BackgroundKind[] = ["bash", "subagent", "monitor"];

const UNDELIVERED: Readonly<Record<BackgroundKind, (sessionId: string) => boolean>> = {
    bash: (sessionId) => getBackgroundManager(sessionId).hasUndelivered(),
    subagent: (sessionId) => getBackgroundSubagentManager(sessionId).hasUndelivered(),
    monitor: (sessionId) => getMonitorManager(sessionId).hasUndelivered(),
};

// Round-robin start offset, advanced past whichever kind last won. A fixed scan
// order would let one kind that always has something waiting keep the kinds
// after it from ever being reported.
let scanCursor = 0;

export const anyBackgroundRunning = (sessionId: string): boolean =>
    getBackgroundManager(sessionId).hasRunning() ||
    getBackgroundSubagentManager(sessionId).hasRunning() ||
    getMonitorManager(sessionId).runningCount() > 0;

// Resolves as soon as ANY background kind has a result waiting. Awaiting the
// managers in sequence instead would pin a finished subagent behind an
// unrelated long-running shell command — the subagent's wakeup could not fire
// until the build it had nothing to do with completed. Rejects when the signal
// aborts (user typed something).
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
            for (let step = 0; step < KINDS.length; step += 1) {
                const index = (scanCursor + step) % KINDS.length;
                const kind = KINDS[index]!;
                if (UNDELIVERED[kind](sessionId)) {
                    scanCursor = (index + 1) % KINDS.length;
                    settle(() => resolve(kind));
                    return;
                }
            }
        }, POLL_INTERVAL_MS);
        interval.unref?.();
    });
