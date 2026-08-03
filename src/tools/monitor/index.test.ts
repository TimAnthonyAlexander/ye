import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Config } from "../../config/index.ts";
import {
    _resetMonitorTimings,
    _setMonitorTimings,
    destroyMonitorManager,
    getMonitorManager,
} from "../../monitors/index.ts";
import type { Provider } from "../../providers/index.ts";
import { KillMonitorTool } from "../killMonitor/index.ts";
// listTools, not getTool: another suite mock.modules the tools barrel
// process-globally, which clobbers getTool for every importer.
import { listTools } from "../registry.ts";
import type { ToolContext } from "../types.ts";
import { MonitorTool } from "./index.ts";

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
    return () => `monitor-test-session-${++n}`;
})();

let sessionId: string;

const makeCtx = (headless = false): ToolContext => ({
    cwd: "/tmp",
    signal: new AbortController().signal,
    sessionId,
    projectId: "monitor-test-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: stubConfig,
    activeModel: "stub-model",
    headless,
    log: () => {},
});

// A future `at` with no condition parks the monitor in its wakeable sleep, so
// no test here ever spawns a shell.
const FAR_FUTURE = "2099-01-01T00:00:00Z";

const start = async (args: Record<string, unknown>, headless = false): Promise<string> => {
    const res = await MonitorTool.execute(args, makeCtx(headless));
    if (!res.ok) throw new Error(`expected success, got: ${res.error}`);
    return res.value as string;
};

beforeEach(() => {
    sessionId = uniqueSession();
    _setMonitorTimings({ intervalFloorMs: 5, pollTimeoutMs: 500 });
});

afterEach(() => {
    destroyMonitorManager(sessionId);
    _resetMonitorTimings();
});

describe("Monitor", () => {
    test("a valid spec starts a monitor and returns its id", async () => {
        const text = await start({ reason: "deploy finishes", at: FAR_FUTURE });
        expect(text).toContain("Monitor started: monitor-1");
        expect(text).toContain("deploy finishes");
        expect(getMonitorManager(sessionId).runningCount()).toBe(1);
    });

    test("returns immediately with the monitor still running", async () => {
        await start({ reason: "still going", condition: "exit 1", intervalSec: 1 });
        expect(getMonitorManager(sessionId).runningCount()).toBe(1);
    });

    // The engine throws on a spec it cannot run; a throw out of execute is a
    // crashed turn, so both of these have to come back as tool errors.
    test("neither condition nor at is a clean tool error, not a throw", async () => {
        const res = await MonitorTool.execute({ reason: "nothing to wait for" }, makeCtx());
        expect(res.ok).toBe(false);
        if (res.ok) throw new Error("expected failure");
        expect(res.error).toContain("condition");
        expect(res.error).toContain("at");
        expect(getMonitorManager(sessionId).runningCount()).toBe(0);
    });

    test("a malformed at is a clean tool error naming what was wrong", async () => {
        const res = await MonitorTool.execute(
            { reason: "wait for it", at: "half past four" },
            makeCtx(),
        );
        expect(res.ok).toBe(false);
        if (res.ok) throw new Error("expected failure");
        expect(res.error).toContain("ISO 8601");
        expect(res.error).toContain("half past four");
        expect(getMonitorManager(sessionId).runningCount()).toBe(0);
    });

    describe("the returned payload", () => {
        test("instructs the model to end its turn", async () => {
            const text = await start({ reason: "build finishes", at: FAR_FUTURE });
            expect(text).toContain("END YOUR TURN");
        });

        test("states that the result arrives automatically while idle", async () => {
            const text = await start({ reason: "build finishes", at: FAR_FUTURE });
            expect(text).toContain("automatically");
            expect(text).toContain("idle");
            expect(text).toContain("<system-reminder>");
        });

        test("never tells the model to check on the monitor", async () => {
            const text = await start({ reason: "build finishes", at: FAR_FUTURE });
            expect(text).toContain("nothing to check");
            expect(text).not.toContain("check status");
        });
    });

    describe("the headless clamp", () => {
        test("applies to a longer deadline and is stated in the text", async () => {
            const text = await start(
                { reason: "overnight job", at: FAR_FUTURE, giveUpAfterSec: 86_400 },
                true,
            );
            expect(text).toContain("clamped to 3600s");
        });

        test("applies when no deadline was given, since the default is a day", async () => {
            const text = await start({ reason: "overnight job", at: FAR_FUTURE }, true);
            expect(text).toContain("clamped to 3600s");
        });

        test("leaves a shorter deadline alone", async () => {
            const text = await start(
                { reason: "quick wait", at: FAR_FUTURE, giveUpAfterSec: 60 },
                true,
            );
            expect(text).not.toContain("clamped");
        });

        test("does not apply outside headless runs", async () => {
            const text = await start(
                { reason: "overnight job", at: FAR_FUTURE, giveUpAfterSec: 86_400 },
                false,
            );
            expect(text).not.toContain("clamped");
        });
    });

    describe("the description", () => {
        test("warns that the condition is polled unattended and must be safe", () => {
            expect(MonitorTool.description).toContain("unattended");
            expect(MonitorTool.description).toContain("side effects");
            expect(MonitorTool.description).toContain("approves every future poll");
        });
    });

    describe("registration", () => {
        test("Monitor and KillMonitor are registered", () => {
            expect(listTools()).toContain(MonitorTool);
            expect(listTools()).toContain(KillMonitorTool);
        });

        test("neither is read-only: both run shell commands", () => {
            expect(MonitorTool.annotations.readOnlyHint).toBe(false);
            expect(KillMonitorTool.annotations.readOnlyHint).toBe(false);
        });
    });
});
