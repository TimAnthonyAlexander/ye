import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Config } from "../../config/index.ts";
import {
    _resetMonitorTimings,
    _setMonitorTimings,
    destroyMonitorManager,
    getMonitorManager,
} from "../../monitors/index.ts";
import type { Provider } from "../../providers/index.ts";
import { MonitorTool } from "../monitor/index.ts";
import type { ToolContext } from "../types.ts";
import { KillMonitorTool } from "./index.ts";

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
    return () => `kill-monitor-test-session-${++n}`;
})();

let sessionId: string;

const makeCtx = (): ToolContext => ({
    cwd: "/tmp",
    signal: new AbortController().signal,
    sessionId,
    projectId: "kill-monitor-test-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: stubConfig,
    activeModel: "stub-model",
    headless: false,
    log: () => {},
});

const FAR_FUTURE = "2099-01-01T00:00:00Z";

const startMonitor = async (reason: string): Promise<string> => {
    const res = await MonitorTool.execute({ reason, at: FAR_FUTURE }, makeCtx());
    if (!res.ok) throw new Error(`expected success, got: ${res.error}`);
    const id = /monitor-\d+/.exec(res.value as string)?.[0];
    if (id === undefined) throw new Error(`no monitor id in: ${res.value as string}`);
    return id;
};

beforeEach(() => {
    sessionId = uniqueSession();
    _setMonitorTimings({ intervalFloorMs: 5, pollTimeoutMs: 500 });
});

afterEach(() => {
    destroyMonitorManager(sessionId);
    _resetMonitorTimings();
});

describe("KillMonitor", () => {
    test("stops a running monitor", async () => {
        const id = await startMonitor("deploy finishes");
        const res = await KillMonitorTool.execute({ monitor_id: id }, makeCtx());
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error(res.error);
        expect(res.value as string).toContain(id);
        expect(getMonitorManager(sessionId).runningCount()).toBe(0);
    });

    test("an unknown id lists the running ones instead of failing blind", async () => {
        const id = await startMonitor("deploy finishes");
        const res = await KillMonitorTool.execute({ monitor_id: "monitor-99" }, makeCtx());
        expect(res.ok).toBe(false);
        if (res.ok) throw new Error("expected failure");
        expect(res.error).toContain("monitor-99");
        expect(res.error).toContain(id);
        expect(res.error).toContain("deploy finishes");
    });

    test("says so plainly when nothing is running", async () => {
        const res = await KillMonitorTool.execute({ monitor_id: "monitor-1" }, makeCtx());
        expect(res.ok).toBe(false);
        if (res.ok) throw new Error("expected failure");
        expect(res.error).toContain("No monitors are running");
    });

    test("a monitor already killed cannot be killed twice", async () => {
        const id = await startMonitor("deploy finishes");
        await KillMonitorTool.execute({ monitor_id: id }, makeCtx());
        const res = await KillMonitorTool.execute({ monitor_id: id }, makeCtx());
        expect(res.ok).toBe(false);
    });
});
