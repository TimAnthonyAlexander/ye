import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Same stub as subagents/background.test.ts: a started subagent stays "running"
// until the test drives it to a terminal state.
mock.module("../subagents/isolate/inProcess.ts", () => ({
    runInProcess: async (): Promise<never> => new Promise(() => {}),
}));

import type { Config } from "../config/index.ts";
import type { Provider } from "../providers/index.ts";
import {
    destroyBackgroundSubagentManager,
    getBackgroundSubagentManager,
} from "../subagents/background.ts";
import { destroyBackgroundManager, getBackgroundManager } from "../tools/bash/background.ts";
import {
    destroyMonitorManager,
    getMonitorManager,
    _resetMonitorTimings,
    _setMonitorTimings,
} from "../monitors/index.ts";
import {
    anyBackgroundRunning,
    waitForAnyBackgroundCompletion,
    WAKEUP_REMINDERS,
    type BackgroundKind,
} from "./backgroundWakeup.ts";

const stubProvider: Provider = {
    id: "stub",
    capabilities: { promptCache: false, toolUse: true, vision: false, serverSideWebSearch: false },
    async *stream() {
        // no-op
    },
    async getContextSize() {
        return 100_000;
    },
};

const stubConfig: Config = {
    defaultProvider: "stub",
    providers: { stub: { baseUrl: "https://example.test", apiKeyEnv: "STUB_KEY" } },
    defaultModel: { provider: "stub", model: "stub-model" },
};

const uniqueSession = (() => {
    let n = 0;
    return () => `wakeup-test-session-${++n}`;
})();

let sessionId: string;

const spawnCtx = {
    parentProjectId: "proj-1",
    parentProjectRoot: "/tmp/test",
    parentSessionId: "parent-1",
    contextWindow: 100_000,
    config: stubConfig,
    provider: stubProvider,
    signal: new AbortController().signal,
};

const startSubagent = (): string =>
    getBackgroundSubagentManager(sessionId).start(
        { kind: "verification", prompt: "verify" },
        spawnCtx,
    );

// timeoutMs 0 disables the kill timer, so this stays running for the test.
const startLongBashTask = (): string =>
    getBackgroundManager(sessionId).start("sleep 20", ".", 0, "");

const finishSubagent = (id: string): void => {
    const task = getBackgroundSubagentManager(sessionId).poll(id)!;
    task.status = "completed";
    task.summary = "all clear";
};

// `true` exits 0 on the first poll, so the monitor reaches condition_met at
// once; `false` exits 1 forever, so it stays running for the whole test.
const startMonitor = (condition: string): string =>
    getMonitorManager(sessionId).start({ reason: "watch", condition }, ".");

const waitUntil = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 400; i += 1) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("predicate never became true");
};

beforeEach(() => {
    sessionId = uniqueSession();
    _setMonitorTimings({ intervalFloorMs: 20, pollTimeoutMs: 5_000 });
});

afterEach(() => {
    destroyBackgroundManager(sessionId);
    destroyBackgroundSubagentManager(sessionId);
    destroyMonitorManager(sessionId);
    _resetMonitorTimings();
});

describe("anyBackgroundRunning", () => {
    test("false when nothing has been started", () => {
        expect(anyBackgroundRunning(sessionId)).toBe(false);
    });

    test("true for a running bash task", () => {
        startLongBashTask();
        expect(anyBackgroundRunning(sessionId)).toBe(true);
    });

    test("true for a running subagent", () => {
        startSubagent();
        expect(anyBackgroundRunning(sessionId)).toBe(true);
    });

    test("true for a running monitor", () => {
        startMonitor("false");
        expect(anyBackgroundRunning(sessionId)).toBe(true);
    });
});

describe("waitForAnyBackgroundCompletion", () => {
    // The regression: the wakeup used to await the bash manager first and only
    // then the subagent manager, so a subagent that finished in seconds could
    // not report until an unrelated long-running build completed.
    test("a finished subagent wakes up even while a long bash task still runs", async () => {
        startLongBashTask();
        const subagentId = startSubagent();
        expect(anyBackgroundRunning(sessionId)).toBe(true);

        finishSubagent(subagentId);

        const kind = await waitForAnyBackgroundCompletion(sessionId, new AbortController().signal);
        expect(kind).toBe("subagent");
    });

    test("resolves with 'bash' when a bash task is the one that finished", async () => {
        const id = getBackgroundManager(sessionId).start("true", ".", 0, "");

        const kind = await waitForAnyBackgroundCompletion(sessionId, new AbortController().signal);
        expect(kind).toBe("bash");
        expect(getBackgroundManager(sessionId).poll(id)!.status).toBe("completed");
    });

    // The waiter must not consume the completion; the turn's drain is what
    // delivers it into history.
    test("leaves the completed task undelivered for the drain to pick up", async () => {
        const subagentId = startSubagent();
        finishSubagent(subagentId);

        await waitForAnyBackgroundCompletion(sessionId, new AbortController().signal);

        const drained = getBackgroundSubagentManager(sessionId).drainCompleted();
        expect(drained.map((t) => t.id)).toContain(subagentId);
    });

    test("a finished monitor wakes up even while a long bash task still runs", async () => {
        startLongBashTask();
        startMonitor("true");

        const kind = await waitForAnyBackgroundCompletion(sessionId, new AbortController().signal);
        expect(kind).toBe("monitor");
    });

    // With all three kinds holding a result, a fixed scan order would report the
    // same kind forever and the other two would never wake the agent.
    test("the three-way race reports every kind — none starves", async () => {
        getBackgroundManager(sessionId).start("true", ".", 0, "");
        finishSubagent(startSubagent());
        startMonitor("true");
        await waitUntil(
            () =>
                getBackgroundManager(sessionId).hasUndelivered() &&
                getMonitorManager(sessionId).hasUndelivered(),
        );

        const seen: BackgroundKind[] = [];
        for (let i = 0; i < 3; i += 1) {
            seen.push(
                await waitForAnyBackgroundCompletion(sessionId, new AbortController().signal),
            );
        }

        expect([...seen].sort()).toEqual(["bash", "monitor", "subagent"]);
    });

    test("leaves the completed monitor undelivered for the drain to pick up", async () => {
        const monitorId = startMonitor("true");

        await waitForAnyBackgroundCompletion(sessionId, new AbortController().signal);

        const drained = getMonitorManager(sessionId).drainCompleted();
        expect(drained.map((t) => t.id)).toContain(monitorId);
    });

    test("rejects when the signal aborts, so user input takes over", async () => {
        startSubagent();
        const ctrl = new AbortController();
        const pending = waitForAnyBackgroundCompletion(sessionId, ctrl.signal);
        ctrl.abort();

        await expect(pending).rejects.toThrow("aborted");
    });

    test("rejects immediately when given an already-aborted signal", async () => {
        startSubagent();
        const ctrl = new AbortController();
        ctrl.abort();

        await expect(waitForAnyBackgroundCompletion(sessionId, ctrl.signal)).rejects.toThrow(
            "aborted",
        );
    });
});

describe("monitor teardown", () => {
    test("destroyMonitorManager kills a running monitor", async () => {
        startMonitor("false");
        expect(getMonitorManager(sessionId).runningCount()).toBe(1);

        destroyMonitorManager(sessionId);

        expect(getMonitorManager(sessionId).runningCount()).toBe(0);
        expect(getMonitorManager(sessionId).list()).toHaveLength(0);
        expect(anyBackgroundRunning(sessionId)).toBe(false);
    });
});

describe("WAKEUP_REMINDERS", () => {
    // These are injected right before the result itself, so they must not send
    // the model off to fetch what it already has.
    test("no reminder tells the model to fetch the output", () => {
        expect(WAKEUP_REMINDERS.bash).toContain("do not call BashOutput");
        expect(WAKEUP_REMINDERS.subagent).toContain("do not call TaskOutput");
        expect(WAKEUP_REMINDERS.monitor).toContain("do not call Monitor");
        expect(WAKEUP_REMINDERS.bash).not.toContain("check the output");
        expect(WAKEUP_REMINDERS.subagent).not.toContain("check its output");
    });
});
