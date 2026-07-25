import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Same stub as subagents/background.test.ts: runInProcess never resolves, so a
// started subagent stays "running" until the test mutates or kills it. Bun's
// module mocks are process-global, so this must stay behaviourally identical to
// that file's mock.
mock.module("../../subagents/isolate/inProcess.ts", () => ({
    runInProcess: async (): Promise<never> => new Promise(() => {}),
}));

import type { Config } from "../../config/index.ts";
import type { Provider } from "../../providers/index.ts";
import {
    destroyBackgroundSubagentManager,
    getBackgroundSubagentManager,
} from "../../subagents/background.ts";
import type { ToolContext } from "../types.ts";
import { TaskOutputTool } from "./index.ts";

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
    return () => `taskoutput-test-session-${++n}`;
})();

let sessionId: string;

const makeCtx = (): ToolContext => ({
    cwd: "/tmp/test",
    signal: new AbortController().signal,
    sessionId,
    projectId: "taskoutput-test-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: stubConfig,
    activeModel: "stub-model",
    log: () => {},
});

const spawnCtx = {
    parentProjectId: "proj-1",
    parentProjectRoot: "/tmp/test",
    parentSessionId: "parent-1",
    contextWindow: 100_000,
    config: stubConfig,
    provider: stubProvider,
    signal: new AbortController().signal,
};

const startRunning = (): string =>
    getBackgroundSubagentManager(sessionId).start(
        { kind: "verification", prompt: "verify the rewrite" },
        spawnCtx,
    );

beforeEach(() => {
    sessionId = uniqueSession();
});

afterEach(() => {
    destroyBackgroundSubagentManager(sessionId);
});

describe("TaskOutput", () => {
    test("unknown id is an error", async () => {
        const res = await TaskOutputTool.execute({ task_id: "subagent-404" }, makeCtx());
        expect(res.ok).toBe(false);
        if (res.ok) throw new Error("expected failure");
        expect(res.error).toContain("no background subagent");
    });

    // The regression this whole change exists to prevent: polling a running
    // subagent used to return ok:true with "[still running]", which read as a
    // legitimate move and drove a once-per-second poll loop.
    describe("while the subagent is running", () => {
        test("refuses the call instead of reporting status", async () => {
            const id = startRunning();
            const res = await TaskOutputTool.execute({ task_id: id }, makeCtx());
            expect(res.ok).toBe(false);
        });

        test("never returns a 'still running' status as a successful result", async () => {
            const id = startRunning();
            const res = await TaskOutputTool.execute({ task_id: id }, makeCtx());
            if (res.ok) throw new Error("polling a running subagent must not succeed");
            expect(res.error).not.toContain("[still running");
        });

        test("tells the model to end its turn and wait for the wakeup", async () => {
            const id = startRunning();
            const res = await TaskOutputTool.execute({ task_id: id }, makeCtx());
            if (res.ok) throw new Error("expected failure");
            expect(res.error).toContain(id);
            expect(res.error).toContain("END YOUR TURN");
            expect(res.error).toContain("automatically");
        });

        test("repeated polls keep failing rather than degrading into success", async () => {
            const id = startRunning();
            const ctx = makeCtx();
            for (let i = 0; i < 3; i++) {
                const res = await TaskOutputTool.execute({ task_id: id }, ctx);
                expect(res.ok).toBe(false);
            }
        });
    });

    // The one legitimate use: re-fetching a finished subagent's result.
    describe("after the subagent finishes", () => {
        test("returns the summary of a completed subagent", async () => {
            const id = startRunning();
            const task = getBackgroundSubagentManager(sessionId).poll(id)!;
            task.status = "completed";
            task.summary = "typecheck clean, 664 tests pass";

            const res = await TaskOutputTool.execute({ task_id: id }, makeCtx());
            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("expected success");
            expect(res.value).toBe("typecheck clean, 664 tests pass");
        });

        test("reports the failure reason of a failed subagent", async () => {
            const id = startRunning();
            const task = getBackgroundSubagentManager(sessionId).poll(id)!;
            task.status = "failed";
            task.error = "provider stream stalled";

            const res = await TaskOutputTool.execute({ task_id: id }, makeCtx());
            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("expected success");
            expect(res.value).toContain("failed");
            expect(res.value).toContain("provider stream stalled");
        });

        test("reports a killed subagent as killed", async () => {
            const id = startRunning();
            getBackgroundSubagentManager(sessionId).kill(id);

            const res = await TaskOutputTool.execute({ task_id: id }, makeCtx());
            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("expected success");
            expect(res.value).toContain("killed");
        });
    });

    test("description does not invite status polling", () => {
        expect(TaskOutputTool.description).toContain("ERROR");
        expect(TaskOutputTool.description.toLowerCase()).not.toContain("poll");
    });
});
