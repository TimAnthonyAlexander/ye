export interface Killable {
    readonly pid: number;
    kill(sig?: number): void;
}

const KILL_GRACE_MS = 500;

// Kill the whole process group of a detached child. We use the negative-pid
// trick so backgrounded grandchildren (anything started with `&`) die with the
// shell, not just the immediate sh process. Falls back to a plain proc.kill if
// the group-kill throws (race with already-exited proc).
export const killGroup = (proc: Killable, sig: NodeJS.Signals): void => {
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

// SIGTERM, then SIGKILL after a grace period, so a child that ignores TERM
// still dies rather than outliving the session. The grace timer is unref'd so a
// pending kill can never hold the process open at exit.
export const killGroupHard = (proc: Killable): void => {
    killGroup(proc, "SIGTERM");
    const timer = setTimeout(() => killGroup(proc, "SIGKILL"), KILL_GRACE_MS);
    timer.unref?.();
};
