import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Config } from "../../config/index.ts";
import type { Provider } from "../../providers/index.ts";
import { destroyBackgroundManager, getBackgroundManager } from "../bash/background.ts";
import type { ToolContext } from "../types.ts";
import { BashOutputTool } from "./index.ts";

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
    return () => `bashoutput-test-session-${++n}`;
})();

let sessionId: string;

const makeCtx = (): ToolContext => ({
    cwd: ".",
    signal: new AbortController().signal,
    sessionId,
    projectId: "bashoutput-test-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: stubConfig,
    activeModel: "stub-model",
    log: () => {},
});

// timeoutMs 0 disables the kill timer, so the task stays running for the test.
const startRunning = (): string => getBackgroundManager(sessionId).start("sleep 20", ".", 0, "");

beforeEach(() => {
    sessionId = uniqueSession();
});

afterEach(() => {
    destroyBackgroundManager(sessionId);
});

describe("BashOutput", () => {
    test("unknown id is an error", async () => {
        const res = await BashOutputTool.execute({ bash_id: "bash-404" }, makeCtx());
        expect(res.ok).toBe(false);
        if (res.ok) throw new Error("expected failure");
        expect(res.error).toContain("no background task");
    });

    describe("running with no output yet", () => {
        // A peek at a task that has printed nothing can only have been a
        // "is it done?" check, so it is refused rather than confirmed.
        test("refuses the call", async () => {
            const id = startRunning();
            const res = await BashOutputTool.execute({ bash_id: id }, makeCtx());
            expect(res.ok).toBe(false);
        });

        test("tells the model to end its turn and wait", async () => {
            const id = startRunning();
            const res = await BashOutputTool.execute({ bash_id: id }, makeCtx());
            if (res.ok) throw new Error("expected failure");
            expect(res.error).toContain(id);
            expect(res.error).toContain("END YOUR TURN");
        });
    });

    describe("running with partial output", () => {
        test("returns the partial output — the one legitimate use", async () => {
            const id = startRunning();
            getBackgroundManager(sessionId).poll(id)!.stdout = "Compiling module 3/40";

            const res = await BashOutputTool.execute({ bash_id: id }, makeCtx());
            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("expected success");
            expect(res.value).toContain("Compiling module 3/40");
        });

        test("still warns against polling for completion", async () => {
            const id = startRunning();
            getBackgroundManager(sessionId).poll(id)!.stdout = "Compiling module 3/40";

            const res = await BashOutputTool.execute({ bash_id: id }, makeCtx());
            if (!res.ok) throw new Error("expected success");
            expect(res.value).toContain("still running");
            expect(res.value).toContain("do not call BashOutput again");
        });

        test("includes stderr when present", async () => {
            const id = startRunning();
            const task = getBackgroundManager(sessionId).poll(id)!;
            task.stdout = "building";
            task.stderr = "warning: unused import";

            const res = await BashOutputTool.execute({ bash_id: id }, makeCtx());
            if (!res.ok) throw new Error("expected success");
            expect(res.value).toContain("<stderr>");
            expect(res.value).toContain("warning: unused import");
        });
    });

    test("a completed task returns the full formatted result", async () => {
        const id = startRunning();
        const task = getBackgroundManager(sessionId).poll(id)!;
        task.status = "completed";
        task.stdout = "all good";
        task.exitCode = 0;

        const res = await BashOutputTool.execute({ bash_id: id }, makeCtx());
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error("expected success");
        expect(res.value).toContain('<bash exit_code="0"');
        expect(res.value).toContain("all good");
        expect(res.value).toContain("</bash>");
    });

    test("description frames the tool as partial-output-only", () => {
        expect(BashOutputTool.description).toContain("partial output");
        expect(BashOutputTool.description.toLowerCase()).not.toContain("poll");
    });
});
