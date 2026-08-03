import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    _resetMonitorTimings,
    _setMonitorTimings,
    destroyMonitorManager,
    getMonitorManager,
    monitorCompletionNotice,
    resolveMonitorAt,
    type MonitorManager,
    type MonitorTask,
} from "./index.ts";

const uniqueSession = (() => {
    let n = 0;
    return () => `monitor-test-${++n}`;
})();

const tempDirs: string[] = [];

const makeDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "ye-monitor-"));
    tempDirs.push(dir);
    return dir;
};

const find = (mgr: MonitorManager, id: string): MonitorTask => {
    const task = mgr.list().find((t) => t.id === id);
    if (!task) throw new Error(`monitor ${id} not found`);
    return task;
};

async function waitForDone(
    mgr: MonitorManager,
    id: string,
    timeoutMs = 5000,
): Promise<MonitorTask> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const task = find(mgr, id);
        if (task.status !== "running") return task;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`monitor ${id} did not finish within ${timeoutMs}ms`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A counter file makes "becomes true after N polls" deterministic: each poll
// reads the count, writes it back incremented, and answers from the old value.
const counterCondition = (threshold: number): string =>
    `n=$(cat counter); echo $((n+1)) > counter; [ "$n" -ge ${threshold} ]`;

const seedCounter = (dir: string): void => writeFileSync(join(dir, "counter"), "0\n");

beforeAll(() => _setMonitorTimings({ intervalFloorMs: 5 }));

afterAll(() => {
    _resetMonitorTimings();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("monitor lifecycle", () => {
    test("condition becoming true after N polls fires condition_met with the capture output", async () => {
        const dir = makeDir();
        seedCounter(dir);
        writeFileSync(join(dir, "payload.txt"), "sprt finished: elo +12\n");
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);

        const id = mgr.start(
            {
                reason: "wait for sprt",
                condition: counterCondition(2),
                capture: "cat payload.txt",
                intervalSec: 0.02,
            },
            dir,
        );
        expect(id).toBe("monitor-1");

        const task = await waitForDone(mgr, id);
        expect(task.status).toBe("condition_met");
        expect(task.polls).toBe(3);
        expect(task.output).toContain("elo +12");
        expect(task.error).toBeUndefined();
        expect(task.finishedAt).toBeGreaterThanOrEqual(task.startedAt);
        destroyMonitorManager(sid);
    });

    test("at in the past fires time_reached immediately without polling", () => {
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        const id = mgr.start(
            { reason: "already due", at: new Date(Date.now() - 60_000).toISOString() },
            makeDir(),
        );
        const task = find(mgr, id);
        expect(task.status).toBe("time_reached");
        expect(task.polls).toBe(0);
        destroyMonitorManager(sid);
    });

    test("at + condition: the condition wins when it becomes true first", async () => {
        const dir = makeDir();
        seedCounter(dir);
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        const id = mgr.start(
            {
                reason: "race, condition first",
                condition: counterCondition(1),
                at: new Date(Date.now() + 60_000).toISOString(),
                intervalSec: 0.02,
            },
            dir,
        );
        const task = await waitForDone(mgr, id);
        expect(task.status).toBe("condition_met");
        destroyMonitorManager(sid);
    });

    test("at + condition: the clock wins when the condition stays false", async () => {
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        const id = mgr.start(
            {
                reason: "race, clock first",
                condition: "false",
                at: new Date(Date.now() + 150).toISOString(),
                intervalSec: 0.02,
                giveUpAfterSec: 60,
            },
            makeDir(),
        );
        const task = await waitForDone(mgr, id);
        expect(task.status).toBe("time_reached");
        expect(task.polls).toBeGreaterThan(0);
        destroyMonitorManager(sid);
    });

    test("deadline with a false condition gives up", async () => {
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        const id = mgr.start(
            {
                reason: "never true",
                condition: "false",
                intervalSec: 0.02,
                giveUpAfterSec: 0.1,
            },
            makeDir(),
        );
        const task = await waitForDone(mgr, id);
        expect(task.status).toBe("gave_up");
        expect(task.polls).toBeGreaterThan(0);
        expect(task.output).toBe("");
        destroyMonitorManager(sid);
    });

    test("capture runs for a time_reached outcome too", async () => {
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        const id = mgr.start(
            {
                reason: "scheduled report",
                at: new Date(Date.now() - 1000).toISOString(),
                capture: "echo scheduled-payload",
            },
            makeDir(),
        );
        const task = await waitForDone(mgr, id);
        expect(task.status).toBe("time_reached");
        expect(task.output).toContain("scheduled-payload");
        destroyMonitorManager(sid);
    });
});

describe("error vs not-yet", () => {
    test("three consecutive errors stop the monitor as broken and report the stderr", async () => {
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        const id = mgr.start(
            {
                reason: "ssh key expired",
                condition: "echo permission-denied-publickey >&2; exit 255",
                intervalSec: 0.02,
            },
            makeDir(),
        );
        const task = await waitForDone(mgr, id);
        expect(task.status).toBe("broken");
        expect(task.polls).toBe(3);
        expect(task.error).toContain("permission-denied-publickey");
        expect(task.output).toContain("3 times in a row");
        destroyMonitorManager(sid);
    });

    test("a single error between not-yet answers does not break the monitor", async () => {
        const dir = makeDir();
        seedCounter(dir);
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        const id = mgr.start(
            {
                reason: "one flaky poll",
                condition: `n=$(cat counter); echo $((n+1)) > counter; if [ "$n" -eq 1 ]; then echo flake >&2; exit 7; fi; [ "$n" -ge 4 ]`,
                intervalSec: 0.02,
            },
            dir,
        );
        const task = await waitForDone(mgr, id);
        expect(task.status).toBe("condition_met");
        expect(task.polls).toBe(5);
        destroyMonitorManager(sid);
    });

    test("a poll that times out counts as an error, not as not-yet", async () => {
        _setMonitorTimings({ pollTimeoutMs: 80 });
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        const id = mgr.start(
            { reason: "hung ssh", condition: "sleep 30", intervalSec: 0.02 },
            makeDir(),
        );
        const task = await waitForDone(mgr, id);
        expect(task.status).toBe("broken");
        expect(task.polls).toBe(3);
        expect(task.error).toContain("timed out");
        destroyMonitorManager(sid);
        _resetMonitorTimings();
        _setMonitorTimings({ intervalFloorMs: 5 });
    });

    test("exit 1 alone never breaks the monitor", async () => {
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        const id = mgr.start(
            {
                reason: "many not-yets",
                condition: "exit 1",
                intervalSec: 0.02,
                giveUpAfterSec: 0.2,
            },
            makeDir(),
        );
        const task = await waitForDone(mgr, id);
        expect(task.status).toBe("gave_up");
        expect(task.polls).toBeGreaterThan(3);
        destroyMonitorManager(sid);
    });
});

describe("kill", () => {
    test("kill stops an in-flight poll and marks the monitor killed", async () => {
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        const id = mgr.start(
            { reason: "long poll", condition: "sleep 30", intervalSec: 0.02 },
            makeDir(),
        );
        await sleep(50);
        expect(mgr.runningCount()).toBe(1);
        expect(mgr.kill(id)).toBe(true);
        expect(find(mgr, id).status).toBe("killed");
        expect(mgr.runningCount()).toBe(0);
        await sleep(100);
        expect(find(mgr, id).status).toBe("killed");
        destroyMonitorManager(sid);
    });

    test("kill returns false for an unknown id and for a finished monitor", async () => {
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        expect(mgr.kill("monitor-404")).toBe(false);
        const id = mgr.start(
            { reason: "instant", at: new Date(Date.now() - 1).toISOString() },
            makeDir(),
        );
        await waitForDone(mgr, id);
        expect(mgr.kill(id)).toBe(false);
        destroyMonitorManager(sid);
    });
});

describe("delivery", () => {
    test("drainCompleted returns each task once and hasUndelivered tracks it", async () => {
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        expect(mgr.hasUndelivered()).toBe(false);

        const running = mgr.start(
            { reason: "still going", condition: "sleep 30", intervalSec: 0.02 },
            makeDir(),
        );
        const done = mgr.start(
            { reason: "due now", at: new Date(Date.now() - 1).toISOString() },
            makeDir(),
        );
        await waitForDone(mgr, done);

        expect(mgr.hasUndelivered()).toBe(true);
        const first = mgr.drainCompleted();
        expect(first.map((t) => t.id)).toEqual([done]);
        expect(mgr.hasUndelivered()).toBe(false);
        expect(mgr.drainCompleted()).toEqual([]);

        mgr.kill(running);
        expect(mgr.hasUndelivered()).toBe(true);
        expect(mgr.drainCompleted().map((t) => t.id)).toEqual([running]);
        expect(mgr.hasUndelivered()).toBe(false);
        destroyMonitorManager(sid);
    });

    test("ids are sequential and list reports every monitor", () => {
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        const a = mgr.start({ reason: "a", condition: "sleep 30" }, makeDir());
        const b = mgr.start({ reason: "b", condition: "sleep 30" }, makeDir());
        expect([a, b]).toEqual(["monitor-1", "monitor-2"]);
        expect(mgr.list().map((t) => t.reason)).toEqual(["a", "b"]);
        destroyMonitorManager(sid);
    });

    test("managers are per session and destroy clears them", () => {
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        expect(getMonitorManager(sid)).toBe(mgr);
        mgr.start({ reason: "x", condition: "sleep 30" }, makeDir());
        destroyMonitorManager(sid);
        expect(mgr.list()).toEqual([]);
        expect(getMonitorManager(sid)).not.toBe(mgr);
        destroyMonitorManager(sid);
    });
});

describe("clamping and caps", () => {
    test("the interval floor is enforced against a smaller request", async () => {
        _resetMonitorTimings();
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        const id = mgr.start(
            { reason: "abusive interval", condition: "exit 1", intervalSec: 0.001 },
            makeDir(),
        );
        await sleep(150);
        expect(find(mgr, id).polls).toBe(1);
        expect(find(mgr, id).status).toBe("running");
        destroyMonitorManager(sid);
        _setMonitorTimings({ intervalFloorMs: 5 });
    });

    test("captured output is capped at 32k keeping the tail", async () => {
        const dir = makeDir();
        writeFileSync(join(dir, "big.txt"), `${"A".repeat(40_000)}TAIL-MARKER`);
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        const id = mgr.start(
            {
                reason: "huge log",
                at: new Date(Date.now() - 1).toISOString(),
                capture: "cat big.txt",
            },
            dir,
        );
        const task = await waitForDone(mgr, id);
        expect(task.output.endsWith("TAIL-MARKER")).toBe(true);
        expect(task.output.startsWith("…(truncated")).toBe(true);
        expect(task.output).not.toContain("A".repeat(33_000));
        destroyMonitorManager(sid);
    });

    test("a monitor with neither condition nor at is rejected", () => {
        const sid = uniqueSession();
        const mgr = getMonitorManager(sid);
        expect(() => mgr.start({ reason: "nothing to wait on" }, makeDir())).toThrow(
            "needs a condition",
        );
        destroyMonitorManager(sid);
    });
});

describe("resolveMonitorAt", () => {
    const now = new Date(2026, 0, 15, 10, 30, 0).getTime();

    test("HH:MM later today resolves to today", () => {
        const resolved = new Date(resolveMonitorAt("18:45", now));
        expect(resolved.getDate()).toBe(15);
        expect(resolved.getHours()).toBe(18);
        expect(resolved.getMinutes()).toBe(45);
    });

    test("HH:MM already past resolves to tomorrow", () => {
        const resolved = new Date(resolveMonitorAt("09:00", now));
        expect(resolved.getDate()).toBe(16);
        expect(resolved.getHours()).toBe(9);
    });

    test("HH:MM equal to now resolves to the next occurrence", () => {
        const resolved = resolveMonitorAt("10:30", now);
        expect(resolved).toBeGreaterThan(now);
        expect(new Date(resolved).getDate()).toBe(16);
    });

    test("ISO 8601 is parsed as given", () => {
        expect(resolveMonitorAt("2026-03-01T12:00:00Z", now)).toBe(
            Date.parse("2026-03-01T12:00:00Z"),
        );
    });

    test("garbage throws", () => {
        expect(() => resolveMonitorAt("later", now)).toThrow("neither an ISO 8601");
        expect(() => resolveMonitorAt("25:00", now)).toThrow();
    });
});

describe("monitorCompletionNotice", () => {
    const base: MonitorTask = {
        id: "monitor-1",
        reason: "wait for sprt",
        status: "condition_met",
        startedAt: 1000,
        finishedAt: 61_000,
        polls: 4,
        output: "elo +12",
    };

    test("condition_met names the outcome and includes the payload", () => {
        const notice = monitorCompletionNotice(base);
        expect(notice).toContain("condition_met");
        expect(notice).toContain("wait for sprt");
        expect(notice).toContain("elo +12");
    });

    test("time_reached names the outcome", () => {
        expect(monitorCompletionNotice({ ...base, status: "time_reached" })).toContain(
            "time_reached",
        );
    });

    test("gave_up says plainly the condition was never met", () => {
        const notice = monitorCompletionNotice({ ...base, status: "gave_up", output: "" });
        expect(notice).toContain("gave_up");
        expect(notice).toContain("NEVER true");
        expect(notice).toContain("has not been observed to finish");
    });

    test("broken reports the diagnostic and the stderr", () => {
        const notice = monitorCompletionNotice({
            ...base,
            status: "broken",
            output: "The condition command failed 3 times in a row and was never able to answer whether the condition holds.",
            error: "permission denied (publickey)",
        });
        expect(notice).toContain("broken");
        expect(notice).toContain("permission denied (publickey)");
    });

    test("killed names the outcome", () => {
        expect(monitorCompletionNotice({ ...base, status: "killed" })).toContain("killed");
    });
});
