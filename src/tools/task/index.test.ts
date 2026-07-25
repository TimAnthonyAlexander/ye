import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Same stub as subagents/background.test.ts: a started subagent stays "running"
// so the background branch returns without spawning real work.
mock.module("../../subagents/isolate/inProcess.ts", () => ({
    runInProcess: async (): Promise<never> => new Promise(() => {}),
}));

import type { Config } from "../../config/index.ts";
import type { Provider } from "../../providers/index.ts";
import { destroyBackgroundSubagentManager } from "../../subagents/background.ts";
import type { ToolContext } from "../types.ts";
import { TaskTool } from "./index.ts";

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
    return () => `task-test-session-${++n}`;
})();

let sessionId: string;

const makeCtx = (withSubagentContext = true): ToolContext => ({
    cwd: "/tmp/test",
    signal: new AbortController().signal,
    sessionId,
    projectId: "task-test-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider,
    config: stubConfig,
    activeModel: "stub-model",
    log: () => {},
    ...(withSubagentContext
        ? {
              subagentContext: {
                  projectId: "task-test-project",
                  projectRoot: "/tmp/test",
                  parentSessionId: "parent-1",
                  contextWindow: 100_000,
                  provider: stubProvider,
                  config: stubConfig,
              },
          }
        : {}),
});

const runBackground = async (): Promise<string> => {
    const res = await TaskTool.execute(
        { kind: "verification", prompt: "verify the rewrite" },
        makeCtx(),
    );
    if (!res.ok) throw new Error(`expected success, got: ${res.error}`);
    return (res.value as { summary: string }).summary;
};

beforeEach(() => {
    sessionId = uniqueSession();
});

afterEach(() => {
    destroyBackgroundSubagentManager(sessionId);
});

describe("Task", () => {
    test("recursion guard: unavailable without a subagent context", async () => {
        const res = await TaskTool.execute(
            { kind: "explore", prompt: "find stuff" },
            makeCtx(false),
        );
        expect(res.ok).toBe(false);
        if (res.ok) throw new Error("expected failure");
        expect(res.error).toContain("recursion guard");
    });

    test("runs in the background by default and returns an id", async () => {
        const summary = await runBackground();
        expect(summary).toContain("Background subagent started: subagent-");
    });

    // The proximate cause of the poll loop: this payload is the last thing the
    // model reads before choosing its next action, and it used to say
    // "Use TaskOutput to check status".
    describe("the background payload", () => {
        test("instructs the model to end its turn", async () => {
            const summary = await runBackground();
            expect(summary).toContain("END YOUR TURN");
        });

        test("states that the result arrives automatically while idle", async () => {
            const summary = await runBackground();
            expect(summary).toContain("automatically");
            expect(summary).toContain("idle");
        });

        test("never tells the model to check status", async () => {
            const summary = await runBackground();
            expect(summary).not.toContain("check status");
            expect(summary).not.toContain("Use TaskOutput");
        });

        test("warns that TaskOutput errors while the subagent runs", async () => {
            const summary = await runBackground();
            expect(summary).toContain("Do NOT call TaskOutput");
        });
    });

    test("description does not tell the model to poll for status", () => {
        expect(TaskTool.description).not.toContain("check status");
        expect(TaskTool.description).not.toContain("TaskOutput to");
        expect(TaskTool.description).toContain("end your turn");
    });
});
