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
    anyBackgroundRunning,
    waitForAnyBackgroundCompletion,
    WAKEUP_REMINDERS,
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

beforeEach(() => {
    sessionId = uniqueSession();
});

afterEach(() => {
    destroyBackgroundManager(sessionId);
    destroyBackgroundSubagentManager(sessionId);
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

describe("WAKEUP_REMINDERS", () => {
    // These are injected right before the result itself, so they must not send
    // the model off to fetch what it already has.
    test("neither reminder tells the model to fetch the output", () => {
        expect(WAKEUP_REMINDERS.bash).toContain("do not call BashOutput");
        expect(WAKEUP_REMINDERS.subagent).toContain("do not call TaskOutput");
        expect(WAKEUP_REMINDERS.bash).not.toContain("check the output");
        expect(WAKEUP_REMINDERS.subagent).not.toContain("check its output");
    });
});
