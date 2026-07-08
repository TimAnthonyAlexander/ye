import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock runInProcess so it never resolves — tasks stay "running" until we
// explicitly kill them. This keeps tests deterministic and fast.
mock.module("./isolate/inProcess.ts", () => ({
    runInProcess: async (): Promise<never> => new Promise(() => {}),
}));

import { destroyBackgroundSubagentManager, getBackgroundSubagentManager } from "./background.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const uniqueSession = (() => {
    let n = 0;
    return () => `test-session-${++n}`;
})();

const makeCtx = () =>
    ({
        parentProjectId: "proj-1",
        parentProjectRoot: "/tmp/test",
        parentSessionId: uniqueSession(),
        contextWindow: 100_000,
        config: { maxTurns: { subagent: 25 } },
        provider: {},
        signal: new AbortController().signal,
    }) as any;

// ---------------------------------------------------------------------------
// BackgroundSubagentManager (accessed via factory)
// ---------------------------------------------------------------------------

describe("BackgroundSubagentManager", () => {
    let sessionId: string;
    let ctx: ReturnType<typeof makeCtx>;

    beforeEach(() => {
        sessionId = uniqueSession();
        ctx = makeCtx();
    });

    afterEach(() => {
        // Clean up the manager so tests don't leak state.
        destroyBackgroundSubagentManager(sessionId);
    });

    // -- start ---------------------------------------------------------------

    describe("start", () => {
        test("returns an id starting with 'subagent-'", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "hello" }, ctx);
            expect(id.startsWith("subagent-")).toBe(true);
        });

        test("registers the task with status 'running'", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "hello" }, ctx);
            const task = mgr.poll(id);
            expect(task).not.toBeUndefined();
            expect(task!.status).toBe("running");
        });

        test("two starts produce sequential ids", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id1 = mgr.start({ kind: "general", prompt: "first" }, ctx);
            const id2 = mgr.start({ kind: "general", prompt: "second" }, ctx);
            expect(id1).toBe("subagent-1");
            expect(id2).toBe("subagent-2");
        });

        test("task carries the correct kind, prompt, and empty items", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "verification", prompt: "verify this" }, ctx);
            const task = mgr.poll(id)!;
            expect(task.kind).toBe("verification");
            expect(task.prompt).toBe("verify this");
            expect(task.items).toEqual([]);
        });

        test("task has a non-null abortController", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "explore", prompt: "find stuff" }, ctx);
            const task = mgr.poll(id)!;
            expect(task.abortController).not.toBeNull();
        });

        test("task has delivered=false and startedAt is a recent timestamp", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const before = Date.now();
            const id = mgr.start({ kind: "general", prompt: "ts" }, ctx);
            const after = Date.now();
            const task = mgr.poll(id)!;
            expect(task.delivered).toBe(false);
            expect(task.startedAt).toBeGreaterThanOrEqual(before);
            expect(task.startedAt).toBeLessThanOrEqual(after);
        });
    });

    // -- poll ----------------------------------------------------------------

    describe("poll", () => {
        test("returns undefined for an unknown id", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            expect(mgr.poll("nonexistent")).toBeUndefined();
        });

        test("returns the task for a known id", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "poll-me" }, ctx);
            const task = mgr.poll(id);
            expect(task).not.toBeUndefined();
            expect(task!.id).toBe(id);
        });
    });

    // -- kill ----------------------------------------------------------------

    describe("kill", () => {
        test("returns false for an unknown id", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            expect(mgr.kill("nonexistent")).toBe(false);
        });

        test("returns false for an already-killed task", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "kill-me" }, ctx);
            expect(mgr.kill(id)).toBe(true);
            expect(mgr.kill(id)).toBe(false); // already "killed"
        });

        test("returns false for an already-completed task", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "complete-me" }, ctx);
            // Simulate completion by mutating status directly
            mgr.poll(id)!.status = "completed";
            expect(mgr.kill(id)).toBe(false);
        });

        test("returns true for a running task, sets status to 'killed'", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "kill-running" }, ctx);
            expect(mgr.kill(id)).toBe(true);
            expect(mgr.poll(id)!.status).toBe("killed");
        });

        test("calls abort on the task's AbortController", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "abort-me" }, ctx);
            const task = mgr.poll(id)!;
            expect(task.abortController!.signal.aborted).toBe(false);
            mgr.kill(id);
            expect(task.abortController!.signal.aborted).toBe(true);
        });
    });

    // -- drainCompleted ------------------------------------------------------

    describe("drainCompleted", () => {
        test("returns empty array when no tasks exist", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            expect(mgr.drainCompleted()).toEqual([]);
        });

        test("returns empty array when only running tasks exist", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            mgr.start({ kind: "general", prompt: "run" }, ctx);
            expect(mgr.drainCompleted()).toEqual([]);
        });

        test("returns killed tasks (status !== 'running', delivered === false)", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "drain-killed" }, ctx);
            mgr.kill(id);
            const drained = mgr.drainCompleted();
            expect(drained.length).toBe(1);
            expect(drained[0]!.id).toBe(id);
            expect(drained[0]!.status).toBe("killed");
        });

        test("marks tasks as delivered after draining", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "drain-deliver" }, ctx);
            mgr.kill(id);
            mgr.drainCompleted();
            expect(mgr.poll(id)!.delivered).toBe(true);
        });

        test("second drain returns empty (tasks already delivered)", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "drain-twice" }, ctx);
            mgr.kill(id);
            expect(mgr.drainCompleted().length).toBe(1);
            expect(mgr.drainCompleted()).toEqual([]);
        });

        test("returns completed tasks (manually set status)", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "complete-me" }, ctx);
            mgr.poll(id)!.status = "completed";
            const drained = mgr.drainCompleted();
            expect(drained.length).toBe(1);
            expect(drained[0]!.status).toBe("completed");
        });

        test("returns failed tasks (manually set status)", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "fail-me" }, ctx);
            mgr.poll(id)!.status = "failed";
            const drained = mgr.drainCompleted();
            expect(drained.length).toBe(1);
            expect(drained[0]!.status).toBe("failed");
        });

        test("mixes completed, failed, and killed tasks but skips running", () => {
            const mgr = getBackgroundSubagentManager(sessionId);

            const running = mgr.start({ kind: "general", prompt: "keep-running" }, ctx);
            const killed = mgr.start({ kind: "general", prompt: "kill-me" }, ctx);
            const completed = mgr.start({ kind: "general", prompt: "complete-me" }, ctx);
            const failed = mgr.start({ kind: "general", prompt: "fail-me" }, ctx);

            mgr.kill(killed);
            mgr.poll(completed)!.status = "completed";
            mgr.poll(failed)!.status = "failed";

            const drained = mgr.drainCompleted();
            const ids = drained.map((t) => t.id);
            expect(ids).toContain(killed);
            expect(ids).toContain(completed);
            expect(ids).toContain(failed);
            expect(ids).not.toContain(running);
            expect(drained.length).toBe(3);
        });
    });

    // -- hasRunning ----------------------------------------------------------

    describe("hasRunning", () => {
        test("returns false when no tasks exist", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            expect(mgr.hasRunning()).toBe(false);
        });

        test("returns false when all tasks are completed", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "done" }, ctx);
            mgr.poll(id)!.status = "completed";
            expect(mgr.hasRunning()).toBe(false);
        });

        test("returns true when at least one task is running", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            mgr.start({ kind: "general", prompt: "run" }, ctx);
            expect(mgr.hasRunning()).toBe(true);
        });

        test("returns false when the only running task is killed", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "kill-me" }, ctx);
            mgr.kill(id);
            expect(mgr.hasRunning()).toBe(false);
        });

        test("returns true when one task is killed but another is running", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const killedId = mgr.start({ kind: "general", prompt: "kill-me" }, ctx);
            mgr.start({ kind: "general", prompt: "still-running" }, ctx);
            mgr.kill(killedId);
            expect(mgr.hasRunning()).toBe(true);
        });
    });

    // -- runningCount --------------------------------------------------------

    describe("runningCount", () => {
        test("returns 0 when no tasks exist", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            expect(mgr.runningCount()).toBe(0);
        });

        test("returns the count of running tasks only", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            mgr.start({ kind: "general", prompt: "a" }, ctx);
            mgr.start({ kind: "general", prompt: "b" }, ctx);
            mgr.start({ kind: "general", prompt: "c" }, ctx);
            expect(mgr.runningCount()).toBe(3);
        });

        test("excludes killed tasks from the count", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            mgr.start({ kind: "general", prompt: "a" }, ctx);
            const b = mgr.start({ kind: "general", prompt: "b" }, ctx);
            mgr.kill(b);
            expect(mgr.runningCount()).toBe(1);
        });

        test("excludes completed and failed tasks", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const running = mgr.start({ kind: "general", prompt: "run" }, ctx);
            const completed = mgr.start({ kind: "general", prompt: "done" }, ctx);
            const failed = mgr.start({ kind: "general", prompt: "fail" }, ctx);
            mgr.poll(completed)!.status = "completed";
            mgr.poll(failed)!.status = "failed";
            expect(mgr.runningCount()).toBe(1);
            expect(mgr.poll(running)!.status).toBe("running");
        });
    });

    // -- allTasks ------------------------------------------------------------

    describe("allTasks", () => {
        test("returns empty iterator when no tasks exist", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            expect([...mgr.allTasks()]).toEqual([]);
        });

        test("returns all registered tasks regardless of status", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const running = mgr.start({ kind: "general", prompt: "run" }, ctx);
            const killed = mgr.start({ kind: "general", prompt: "kill" }, ctx);
            const completed = mgr.start({ kind: "general", prompt: "done" }, ctx);
            mgr.kill(killed);
            mgr.poll(completed)!.status = "completed";

            const all = [...mgr.allTasks()];
            const ids = all.map((t) => t.id);
            expect(ids).toContain(running);
            expect(ids).toContain(killed);
            expect(ids).toContain(completed);
            expect(all.length).toBe(3);
        });
    });

    // -- cleanup -------------------------------------------------------------

    describe("cleanup", () => {
        test("kills all running tasks and clears the task map", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "clean-me" }, ctx);
            expect(mgr.hasRunning()).toBe(true);

            mgr.cleanup();

            // After cleanup the map is cleared — task is gone.
            expect(mgr.poll(id)).toBeUndefined();
            expect(mgr.hasRunning()).toBe(false);
            expect(mgr.runningCount()).toBe(0);
        });

        test("leaves already-killed tasks as killed (idempotent)", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "already-dead" }, ctx);
            mgr.kill(id);
            expect(mgr.poll(id)!.status).toBe("killed");

            mgr.cleanup();
            // Map cleared, task gone
            expect(mgr.poll(id)).toBeUndefined();
        });
    });

    // -- waitForCompletion ---------------------------------------------------

    describe("waitForCompletion", () => {
        test("returns a promise", () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const promise = mgr.waitForCompletion(new AbortController().signal);
            expect(promise).toBeInstanceOf(Promise);
        });

        test("promise resolves when a non-running, undelivered task exists", async () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const id = mgr.start({ kind: "general", prompt: "resolve-me" }, ctx);

            // Kill the task so it becomes non-running. The poll loop (500 ms)
            // will pick it up since delivered is still false.
            const promise = mgr.waitForCompletion(new AbortController().signal);

            // Kill after a short delay to simulate async completion
            setTimeout(() => mgr.kill(id), 10);

            const resolved = await promise;
            expect(resolved.id).toBe(id);
            expect(resolved.status).toBe("killed");
        });

        test("promise rejects when the signal is already aborted", async () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            const controller = new AbortController();
            controller.abort();

            await expect(mgr.waitForCompletion(controller.signal)).rejects.toThrow("aborted");
        });

        test("promise rejects when the signal is aborted after waiting", async () => {
            const mgr = getBackgroundSubagentManager(sessionId);
            // Start a task that stays running (never-resolving mock).
            mgr.start({ kind: "general", prompt: "wait-forever" }, ctx);

            const controller = new AbortController();
            const promise = mgr.waitForCompletion(controller.signal);

            // Abort after 100ms
            setTimeout(() => controller.abort(), 100);

            await expect(promise).rejects.toThrow("aborted");
        });
    });
});

// ---------------------------------------------------------------------------
// getBackgroundSubagentManager (singleton factory)
// ---------------------------------------------------------------------------

describe("getBackgroundSubagentManager", () => {
    test("returns same instance for the same sessionId", () => {
        const sid = uniqueSession();
        const a = getBackgroundSubagentManager(sid);
        const b = getBackgroundSubagentManager(sid);
        expect(a).toBe(b);
    });

    test("returns different instances for different sessionIds", () => {
        const a = getBackgroundSubagentManager(uniqueSession());
        const b = getBackgroundSubagentManager(uniqueSession());
        expect(a).not.toBe(b);
    });
});

// ---------------------------------------------------------------------------
// destroyBackgroundSubagentManager
// ---------------------------------------------------------------------------

describe("destroyBackgroundSubagentManager", () => {
    test("cleans up the manager and removes it from the registry", () => {
        const sid = uniqueSession();
        const mgr = getBackgroundSubagentManager(sid);
        mgr.start({ kind: "general", prompt: "will-be-destroyed" }, {
            parentProjectId: "proj-1",
            parentProjectRoot: "/tmp/test",
            parentSessionId: sid,
            contextWindow: 100_000,
            config: { maxTurns: { subagent: 25 } },
            provider: {},
            signal: new AbortController().signal,
        } as any);
        expect(mgr.hasRunning()).toBe(true);

        destroyBackgroundSubagentManager(sid);

        // After destroy, a new call returns a different instance.
        const newMgr = getBackgroundSubagentManager(sid);
        expect(newMgr).not.toBe(mgr);
        expect(newMgr.hasRunning()).toBe(false);
    });

    test("is a no-op for an unknown sessionId (does not throw)", () => {
        expect(() => destroyBackgroundSubagentManager("never-registered")).not.toThrow();
    });
});
