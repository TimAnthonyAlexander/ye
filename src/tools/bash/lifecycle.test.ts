import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    destroyBackgroundManager,
    formatBackgroundNotice,
    getBackgroundManager,
    type BackgroundTask,
} from "./background.ts";
import { resolveTimeoutMs } from "./index.ts";

const uniqueSession = (() => {
    let n = 0;
    return () => `lifecycle-test-session-${++n}`;
})();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const exists = async (path: string): Promise<boolean> => {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
};

let sessionId: string;
let workDir: string;

beforeEach(async () => {
    sessionId = uniqueSession();
    workDir = await mkdtemp(join(tmpdir(), "ye-lifecycle-test-"));
});

afterEach(async () => {
    destroyBackgroundManager(sessionId);
    await rm(workDir, { recursive: true, force: true });
});

// A killed task must actually stop running. Asserting only that status flipped
// to "killed" is what let the original bug through: the flag was set while the
// command kept executing with the user's privileges and outlived the session.
// So observe the process, not the bookkeeping — the sentinel file only appears
// if the command was still alive to create it.
describe("killing a background task stops the real process", () => {
    // Positive control: without a kill the sentinel DOES appear. Without this,
    // the kill assertions below would pass even if `touch` never worked at all.
    test("control: an un-killed command does create the sentinel", async () => {
        const sentinel = join(workDir, "control-sentinel");
        getBackgroundManager(sessionId).start(`sleep 0.6; touch '${sentinel}'`, workDir, 0, "");

        await sleep(1200);

        expect(await exists(sentinel)).toBe(true);
    });

    test("kill() prevents the command's later side effect", async () => {
        const sentinel = join(workDir, "kill-sentinel");
        const mgr = getBackgroundManager(sessionId);
        const id = mgr.start(`sleep 0.6; touch '${sentinel}'`, workDir, 0, "");

        expect(mgr.kill(id)).toBe(true);
        await sleep(1200);

        expect(await exists(sentinel)).toBe(false);
    });

    test("a `&`-backgrounded grandchild dies with the shell too", async () => {
        const sentinel = join(workDir, "grandchild-sentinel");
        const mgr = getBackgroundManager(sessionId);
        const id = mgr.start(`(sleep 0.6; touch '${sentinel}') & wait`, workDir, 0, "");

        expect(mgr.kill(id)).toBe(true);
        await sleep(1200);

        expect(await exists(sentinel)).toBe(false);
    });

    test("cleanup() stops running tasks so nothing outlives the session", async () => {
        const sentinel = join(workDir, "cleanup-sentinel");
        getBackgroundManager(sessionId).start(`sleep 0.6; touch '${sentinel}'`, workDir, 0, "");

        destroyBackgroundManager(sessionId);
        await sleep(1200);

        expect(await exists(sentinel)).toBe(false);
    });

    test("a killed task is never resurrected as completed when the process exits", async () => {
        const mgr = getBackgroundManager(sessionId);
        const id = mgr.start("sleep 0.2", workDir, 0, "");
        mgr.kill(id);

        // Well past the command's natural exit, which used to overwrite the
        // terminal status from the reader task.
        await sleep(900);

        expect(mgr.poll(id)!.status).toBe("killed");
        expect(mgr.poll(id)!.exitCode).toBeNull();
    });

    test("killing an already-finished task is a no-op", async () => {
        const mgr = getBackgroundManager(sessionId);
        const id = mgr.start("true", workDir, 0, "");
        await sleep(400);

        expect(mgr.poll(id)!.status).toBe("completed");
        expect(mgr.kill(id)).toBe(false);
    });
});

// A running task's partial output has to be readable while it runs. Buffering
// locally and assigning only at exit left stdout empty for the whole run.
describe("partial output is visible while the task runs", () => {
    test("stdout is readable before the command exits", async () => {
        const mgr = getBackgroundManager(sessionId);
        const id = mgr.start("echo streaming-now; sleep 5", workDir, 0, "");

        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && !mgr.poll(id)!.stdout.includes("streaming-now")) {
            await sleep(50);
        }

        const task = mgr.poll(id)!;
        expect(task.stdout).toContain("streaming-now");
        expect(task.status).toBe("running");
    });
});

describe("timeouts", () => {
    test("a timed-out task is flagged and has no exit code", async () => {
        const mgr = getBackgroundManager(sessionId);
        const id = mgr.start("sleep 10", workDir, 300, "");

        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && mgr.poll(id)!.status === "running") {
            await sleep(50);
        }

        const task = mgr.poll(id)!;
        expect(task.status).toBe("failed");
        expect(task.timedOut).toBe(true);
        expect(task.exitCode).toBeNull();
        expect(task.stderr).toContain("timed out");
    });

    test("background tasks default to the 15 min ceiling, not the 2 min foreground default", () => {
        expect(resolveTimeoutMs(undefined, true)).toBe(900_000);
        expect(resolveTimeoutMs(undefined, false)).toBe(120_000);
    });

    test("an explicit timeout wins for both, still clamped to the ceiling", () => {
        expect(resolveTimeoutMs(5_000, true)).toBe(5_000);
        expect(resolveTimeoutMs(5_000, false)).toBe(5_000);
        expect(resolveTimeoutMs(99_999_999, true)).toBe(900_000);
    });
});

// The notice is the only thing the model sees about a background task, so a
// killed task must not be described as a command that ran and failed.
describe("formatBackgroundNotice", () => {
    const task = (over: Partial<BackgroundTask>): BackgroundTask => ({
        id: "bash-1",
        command: "bun run build",
        toolCallId: "",
        status: "completed",
        stdout: "partial log",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        delivered: false,
        startedAt: 0,
        ...over,
    });

    test("a completed task reports its real exit code", () => {
        const notice = formatBackgroundNotice(task({ exitCode: 0 }), 1500);
        expect(notice).toContain("finished after 1500ms");
        expect(notice).toContain('<bash exit_code="0"');
    });

    test("a genuinely failing command keeps its non-zero exit code", () => {
        const notice = formatBackgroundNotice(task({ status: "failed", exitCode: 2 }), 1500);
        expect(notice).toContain('<bash exit_code="2"');
    });

    test("a killed task is not reported as a failed command", () => {
        const notice = formatBackgroundNotice(task({ status: "killed", exitCode: null }), 800);
        expect(notice).toContain("was killed");
        expect(notice).toContain("partial");
        expect(notice).not.toContain("exit_code");
    });

    test("a timed-out task says so instead of inventing exit code 1", () => {
        const notice = formatBackgroundNotice(
            task({ status: "failed", exitCode: null, timedOut: true }),
            300_000,
        );
        expect(notice).toContain("timeout");
        expect(notice).not.toContain('exit_code="1"');
    });

    test("the command is always named so the model knows which task reported", () => {
        expect(formatBackgroundNotice(task({}), 10)).toContain("Command: bun run build");
    });
});
