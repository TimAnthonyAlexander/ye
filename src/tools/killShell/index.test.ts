import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Config } from "../../config/index.ts";
import type { Provider } from "../../providers/index.ts";
import { destroyBackgroundManager, getBackgroundManager } from "../bash/background.ts";
import type { ToolContext } from "../types.ts";
import { KillShellTool } from "./index.ts";

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
    return () => `killshell-test-session-${++n}`;
})();

let sessionId: string;

const makeCtx = (): ToolContext => ({
    cwd: ".",
    signal: new AbortController().signal,
    sessionId,
    projectId: "killshell-test-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: stubConfig,
    activeModel: "stub-model",
    headless: false,
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

describe("KillShell", () => {
    test("K1 kills a running task", async () => {
        const id = startRunning();
        const res = await KillShellTool.execute({ bash_id: id }, makeCtx());
        expect(res.ok).toBe(true);
        expect(res.ok === true && res.value).toBe(`Killed background task ${id}.`);
        expect(getBackgroundManager(sessionId).poll(id)?.status).toBe("killed");
    });

    // The race the tool exists to survive: the task finishes between the model
    // reading its output and killing it. The contract is "no effect on
    // completed tasks", so that is a no-op, not a failure to go debug.
    test("K2 a task that already finished is a no-op, not an error", async () => {
        const id = startRunning();
        const task = getBackgroundManager(sessionId).poll(id)!;
        task.status = "completed";

        const res = await KillShellTool.execute({ bash_id: id }, makeCtx());
        expect(res.ok).toBe(true);
        expect(res.ok === true && res.value).toContain("already completed");
    });

    test("K3 an unknown id is still an error, and says so differently", async () => {
        const res = await KillShellTool.execute({ bash_id: "bash-404" }, makeCtx());
        expect(res.ok).toBe(false);
        expect(res.ok === false && res.error).toContain('no background task with id "bash-404"');
    });
});
