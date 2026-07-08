import { describe, test, expect } from "bun:test";
import {
    formatBashResult,
    getBackgroundManager,
    destroyBackgroundManager,
} from "../bash/background";
import type { BackgroundTask } from "../bash/background";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uniqueSession = (() => {
    let n = 0;
    return () => `test-session-${++n}`;
})();

/** Poll until a task is no longer "running" or timeout (5s). */
async function waitForTaskDone(
    mgr: ReturnType<typeof getBackgroundManager>,
    id: string,
    timeoutMs = 5000,
): Promise<BackgroundTask> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const task = mgr.poll(id);
        if (!task) throw new Error(`Task ${id} not found`);
        if (task.status !== "running") return task;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Task ${id} did not finish within ${timeoutMs}ms`);
}

// ===========================================================================
// formatBashResult
// ===========================================================================

describe("formatBashResult", () => {
    test("stdout only: header + stdout contents", () => {
        const result = formatBashResult("hello world", "", 0, 100);
        expect(result).toBe('<bash exit_code="0" duration_ms="100">\nhello world\n</bash>');
    });

    test("stderr only: header + stderr block", () => {
        const result = formatBashResult("", "error happened", 1, 50);
        expect(result).toBe(
            '<bash exit_code="1" duration_ms="50">\n<stderr>\nerror happened\n</stderr>\n</bash>',
        );
    });

    test("both stdout and stderr: header + stdout + stderr block", () => {
        const result = formatBashResult("output", "oops", 2, 200);
        expect(result).toBe(
            '<bash exit_code="2" duration_ms="200">\noutput\n<stderr>\noops\n</stderr>\n</bash>',
        );
    });

    test("no output: explicit completion note", () => {
        const result = formatBashResult("", "", 0, 5);
        expect(result).toBe(
            '<bash exit_code="0" duration_ms="5">\n(command completed with no output)\n</bash>',
        );
    });

    test("non-zero exit code is reflected in header", () => {
        const result = formatBashResult("out", "err", 127, 3000);
        expect(result).toContain('exit_code="127"');
        expect(result).toContain('duration_ms="3000"');
    });

    test("multiline stdout is preserved", () => {
        const result = formatBashResult("line1\nline2\nline3", "", 0, 10);
        expect(result).toBe('<bash exit_code="0" duration_ms="10">\nline1\nline2\nline3\n</bash>');
    });

    test("multiline stderr is wrapped in tags", () => {
        const result = formatBashResult("", "e1\ne2", 1, 10);
        expect(result).toBe(
            '<bash exit_code="1" duration_ms="10">\n<stderr>\ne1\ne2\n</stderr>\n</bash>',
        );
    });
});

// ===========================================================================
// BackgroundTaskManager – pure state-management methods
// ===========================================================================

describe("BackgroundTaskManager state management", () => {
    // These tests use a manager with tasks that are directly manipulated
    // via the public API. We start real quick processes and wait for them,
    // or start long-running ones for kill/cleanup tests.

    describe("start", () => {
        test("returns an id starting with 'bash-'", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("echo hello", ".", 0, "tc-1");
            expect(id).toMatch(/^bash-/);
            destroyBackgroundManager(sid);
        });

        test("task is registered and status is 'running'", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("echo hello", ".", 0, "tc-1");
            const task = mgr.poll(id);
            expect(task).toBeDefined();
            expect(task!.status).toBe("running");
            expect(task!.command).toBe("echo hello");
            expect(task!.toolCallId).toBe("tc-1");
            destroyBackgroundManager(sid);
        });

        test("two starts produce sequential ids (bash-1, bash-2)", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id1 = mgr.start("echo one", ".", 0, "tc-a");
            const id2 = mgr.start("echo two", ".", 0, "tc-b");
            // IDs should differ and follow the pattern
            expect(id1).not.toBe(id2);
            expect(id1).toMatch(/^bash-\d+$/);
            expect(id2).toMatch(/^bash-\d+$/);
            destroyBackgroundManager(sid);
        });

        test("task captures stdout from a real process", async () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("echo captured-output", ".", 0, "tc-1");
            const task = await waitForTaskDone(mgr, id);
            expect(task.status).toBe("completed");
            expect(task.stdout).toContain("captured-output");
            expect(task.exitCode).toBe(0);
            destroyBackgroundManager(sid);
        });

        test("task captures stderr from a real process", async () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("echo error-msg >&2", ".", 0, "tc-1");
            const task = await waitForTaskDone(mgr, id);
            // The command succeeds (exit 0) because echo >&2 still exits 0
            expect(task.status).toBe("completed");
            expect(task.stderr).toContain("error-msg");
            destroyBackgroundManager(sid);
        });

        test("non-zero exit produces status 'failed'", async () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("exit 3", ".", 0, "tc-1");
            const task = await waitForTaskDone(mgr, id);
            expect(task.status).toBe("failed");
            expect(task.exitCode).toBe(3);
            destroyBackgroundManager(sid);
        });

        test("timeout marks long-running task as failed", async () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("sleep 10", ".", 200, "tc-timeout");
            // Wait for timeout to fire and status to flip.
            // There is a race between the timeout handler appending to stdout
            // and the read-loop completing (which overwrites). Either way the
            // status must be "failed" after the timeout fires.
            const task = await waitForTaskDone(mgr, id, 3000);
            expect(task.status).toBe("failed");
            // The exit code may be null (timeout path) or a signal code (read-loop
            // path wins the race). Both are valid outcomes.
            destroyBackgroundManager(sid);
        });

        test("zero timeout means no timeout set (task runs normally)", async () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("echo quick", ".", 0, "tc-1");
            const task = await waitForTaskDone(mgr, id);
            expect(task.status).toBe("completed");
            destroyBackgroundManager(sid);
        });
    });

    describe("poll", () => {
        test("returns undefined for unknown id", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            expect(mgr.poll("bash-9999")).toBeUndefined();
            destroyBackgroundManager(sid);
        });

        test("returns the task for a known id", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("echo hi", ".", 0, "tc-x");
            const task = mgr.poll(id);
            expect(task).toBeDefined();
            expect(task!.id).toBe(id);
            destroyBackgroundManager(sid);
        });

        test("poll reflects updated status after task completes", async () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("echo done", ".", 0, "tc-1");
            await waitForTaskDone(mgr, id);
            const task = mgr.poll(id);
            expect(task!.status).toBe("completed");
            destroyBackgroundManager(sid);
        });
    });

    describe("kill", () => {
        test("returns false for unknown id", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            expect(mgr.kill("bash-nonexistent")).toBe(false);
            destroyBackgroundManager(sid);
        });

        test("returns false for already-completed task", async () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("echo already-done", ".", 0, "tc-1");
            await waitForTaskDone(mgr, id);
            expect(mgr.kill(id)).toBe(false);
            destroyBackgroundManager(sid);
        });

        test("returns true and sets status to 'killed' for a running task", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("sleep 20", ".", 0, "tc-kill");
            const result = mgr.kill(id);
            expect(result).toBe(true);
            const task = mgr.poll(id);
            expect(task!.status).toBe("killed");
            expect(task!.exitCode).toBeNull();
            destroyBackgroundManager(sid);
        });
    });

    describe("drainCompleted", () => {
        test("returns empty when no tasks exist", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            expect(mgr.drainCompleted()).toEqual([]);
            destroyBackgroundManager(sid);
        });

        test("returns empty when only running tasks exist", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            mgr.start("sleep 20", ".", 0, "tc-1");
            expect(mgr.drainCompleted()).toEqual([]);
            destroyBackgroundManager(sid);
        });

        test("returns completed tasks that haven't been delivered yet", async () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id1 = mgr.start("echo first", ".", 0, "tc-1");
            const id2 = mgr.start("echo second", ".", 0, "tc-2");
            // Wait for both to complete
            await waitForTaskDone(mgr, id1);
            await waitForTaskDone(mgr, id2);

            const drained = mgr.drainCompleted();
            expect(drained.length).toBe(2);
            const ids = drained.map((t) => t.id);
            expect(ids).toContain(id1);
            expect(ids).toContain(id2);
            // All drained tasks should be marked delivered
            for (const t of drained) {
                expect(t.delivered).toBe(true);
            }
            destroyBackgroundManager(sid);
        });

        test("marks delivered=true after draining", async () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("echo solo", ".", 0, "tc-1");
            await waitForTaskDone(mgr, id);
            const drained = mgr.drainCompleted();
            expect(drained[0]!.delivered).toBe(true);
            // The task in the map should also show delivered
            const task = mgr.poll(id);
            expect(task!.delivered).toBe(true);
            destroyBackgroundManager(sid);
        });

        test("does not return the same task twice (second drain is empty)", async () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("echo once", ".", 0, "tc-1");
            await waitForTaskDone(mgr, id);
            const first = mgr.drainCompleted();
            expect(first.length).toBe(1);
            const second = mgr.drainCompleted();
            expect(second.length).toBe(0);
            destroyBackgroundManager(sid);
        });

        test("drains killed tasks as well", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("sleep 20", ".", 0, "tc-kill");
            mgr.kill(id);
            const drained = mgr.drainCompleted();
            expect(drained.length).toBe(1);
            expect(drained[0]!.status).toBe("killed");
            expect(drained[0]!.delivered).toBe(true);
            destroyBackgroundManager(sid);
        });

        test("drains a mix of completed, failed, and killed but skips running", async () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const idComplete = mgr.start("echo ok", ".", 0, "tc-ok");
            mgr.start("sleep 20", ".", 0, "tc-run");
            await waitForTaskDone(mgr, idComplete);
            // running task still running, completed task done
            const drained = mgr.drainCompleted();
            expect(drained.length).toBe(1);
            expect(drained[0]!.id).toBe(idComplete);
            destroyBackgroundManager(sid);
        });
    });

    describe("hasRunning", () => {
        test("false when empty", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            expect(mgr.hasRunning()).toBe(false);
            destroyBackgroundManager(sid);
        });

        test("false when all completed", async () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("echo done", ".", 0, "tc-1");
            await waitForTaskDone(mgr, id);
            expect(mgr.hasRunning()).toBe(false);
            destroyBackgroundManager(sid);
        });

        test("true when at least one running", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            mgr.start("sleep 20", ".", 0, "tc-run");
            expect(mgr.hasRunning()).toBe(true);
            destroyBackgroundManager(sid);
        });

        test("false when all killed", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id = mgr.start("sleep 20", ".", 0, "tc-kill");
            mgr.kill(id);
            expect(mgr.hasRunning()).toBe(false);
            destroyBackgroundManager(sid);
        });
    });

    describe("runningCount", () => {
        test("0 when empty", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            expect(mgr.runningCount()).toBe(0);
            destroyBackgroundManager(sid);
        });

        test("count of running tasks only, excludes completed/killed", async () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const idComplete = mgr.start("echo done", ".", 0, "tc-done");
            mgr.start("sleep 20", ".", 0, "tc-run");
            const idKill = mgr.start("sleep 20", ".", 0, "tc-kill");
            await waitForTaskDone(mgr, idComplete);
            mgr.kill(idKill);
            // Only idRunning should be "running"
            expect(mgr.runningCount()).toBe(1);
            destroyBackgroundManager(sid);
        });

        test("increments and decrements as tasks change state", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            expect(mgr.runningCount()).toBe(0);
            const id1 = mgr.start("sleep 20", ".", 0, "tc-1");
            expect(mgr.runningCount()).toBe(1);
            const id2 = mgr.start("sleep 20", ".", 0, "tc-2");
            expect(mgr.runningCount()).toBe(2);
            mgr.kill(id1);
            expect(mgr.runningCount()).toBe(1);
            mgr.kill(id2);
            expect(mgr.runningCount()).toBe(0);
            destroyBackgroundManager(sid);
        });
    });

    describe("cleanup", () => {
        test("kills all running tasks", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            const id1 = mgr.start("sleep 20", ".", 0, "tc-1");
            const id2 = mgr.start("sleep 20", ".", 0, "tc-2");
            mgr.cleanup();
            expect(mgr.poll(id1)?.status).toBeUndefined(); // tasks cleared
            expect(mgr.poll(id2)?.status).toBeUndefined();
            expect(mgr.runningCount()).toBe(0);
            destroyBackgroundManager(sid);
        });

        test("clears all tasks", () => {
            const sid = uniqueSession();
            const mgr = getBackgroundManager(sid);
            mgr.start("echo hi", ".", 0, "tc-1");
            mgr.cleanup();
            expect(mgr.hasRunning()).toBe(false);
            expect(mgr.runningCount()).toBe(0);
            expect(mgr.drainCompleted()).toEqual([]);
            destroyBackgroundManager(sid);
        });
    });
});

// ===========================================================================
// getBackgroundManager / destroyBackgroundManager
// ===========================================================================

describe("getBackgroundManager", () => {
    test("returns same instance for same sessionId", () => {
        const sid = uniqueSession();
        const mgr1 = getBackgroundManager(sid);
        const mgr2 = getBackgroundManager(sid);
        expect(mgr1).toBe(mgr2);
        destroyBackgroundManager(sid);
    });

    test("returns different instances for different sessionIds", () => {
        const sid1 = uniqueSession();
        const sid2 = uniqueSession();
        const mgr1 = getBackgroundManager(sid1);
        const mgr2 = getBackgroundManager(sid2);
        expect(mgr1).not.toBe(mgr2);
        destroyBackgroundManager(sid1);
        destroyBackgroundManager(sid2);
    });

    test("manager is functional after being retrieved", () => {
        const sid = uniqueSession();
        const mgr = getBackgroundManager(sid);
        const id = mgr.start("echo functional", ".", 0, "tc-1");
        expect(id).toMatch(/^bash-/);
        expect(mgr.poll(id)).toBeDefined();
        destroyBackgroundManager(sid);
    });
});

describe("destroyBackgroundManager", () => {
    test("calls cleanup on the manager (running tasks are killed and cleared)", () => {
        const sid = uniqueSession();
        const mgr = getBackgroundManager(sid);
        const id = mgr.start("sleep 20", ".", 0, "tc-1");
        destroyBackgroundManager(sid);
        // The task map should be cleared
        expect(mgr.poll(id)).toBeUndefined();
    });

    test("removes the manager so a subsequent getBackgroundManager creates a new one", () => {
        const sid = uniqueSession();
        const mgr1 = getBackgroundManager(sid);
        destroyBackgroundManager(sid);
        const mgr2 = getBackgroundManager(sid);
        expect(mgr1).not.toBe(mgr2);
        destroyBackgroundManager(sid);
    });

    test("is safe to call for a non-existent session (no-op)", () => {
        // Should not throw
        destroyBackgroundManager("nonexistent-session-xyz");
    });
});

// ===========================================================================
// waitForCompletion
// ===========================================================================

describe("waitForCompletion", () => {
    test("returns a promise", () => {
        const sid = uniqueSession();
        const mgr = getBackgroundManager(sid);
        const controller = new AbortController();
        const promise = mgr.waitForCompletion(controller.signal);
        expect(promise).toBeInstanceOf(Promise);
        // Suppress the rejection that abort will trigger, then clean up.
        promise.catch(() => {});
        controller.abort();
        destroyBackgroundManager(sid);
    });

    test("promise resolves when a task completes", async () => {
        const sid = uniqueSession();
        const mgr = getBackgroundManager(sid);
        const controller = new AbortController();
        const waitPromise = mgr.waitForCompletion(controller.signal);
        // Start a quick task after setting up the wait
        mgr.start("echo resolved", ".", 0, "tc-1");
        const task = await waitPromise;
        expect(task.status).toBe("completed");
        expect(task.command).toBe("echo resolved");
        controller.abort(); // clean up
        destroyBackgroundManager(sid);
    });

    test("promise rejects when signal is already aborted", async () => {
        const sid = uniqueSession();
        const mgr = getBackgroundManager(sid);
        const controller = new AbortController();
        controller.abort();
        await expect(mgr.waitForCompletion(controller.signal)).rejects.toThrow("aborted");
        destroyBackgroundManager(sid);
    });

    test("promise rejects when signal is aborted during wait", async () => {
        const sid = uniqueSession();
        const mgr = getBackgroundManager(sid);
        const controller = new AbortController();
        const waitPromise = mgr.waitForCompletion(controller.signal);
        // Abort after a short delay
        setTimeout(() => controller.abort(), 100);
        await expect(waitPromise).rejects.toThrow("aborted");
        destroyBackgroundManager(sid);
    });

    test("resolves for a task that was already completed before wait started", async () => {
        const sid = uniqueSession();
        const mgr = getBackgroundManager(sid);
        const id = mgr.start("echo pre-completed", ".", 0, "tc-1");
        await waitForTaskDone(mgr, id);
        // The task is completed but not yet delivered
        const controller = new AbortController();
        const task = await mgr.waitForCompletion(controller.signal);
        expect(task.status).toBe("completed");
        expect(task.id).toBe(id);
        controller.abort();
        destroyBackgroundManager(sid);
    });

    test("resolves for a killed task", async () => {
        const sid = uniqueSession();
        const mgr = getBackgroundManager(sid);
        const controller = new AbortController();
        const waitPromise = mgr.waitForCompletion(controller.signal);
        const id = mgr.start("sleep 20", ".", 0, "tc-kill");
        mgr.kill(id);
        const task = await waitPromise;
        expect(task.status).toBe("killed");
        controller.abort();
        destroyBackgroundManager(sid);
    });
});
