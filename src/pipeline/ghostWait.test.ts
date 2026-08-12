import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { detectGhostWait, GHOST_WAIT_REMINDER } from "./ghostWait.ts";
import { destroyBackgroundManager, getBackgroundManager } from "../tools/bash/background.ts";
import {
    destroyBackgroundSubagentManager,
    getBackgroundSubagentManager,
} from "../subagents/background.ts";
import { destroyMonitorManager } from "../monitors/index.ts";

const sessionId = "ghost-wait-test-session";

const state = (overrides: Partial<{ mode: string }> = {}) =>
    ({
        sessionId,
        projectId: "test-project",
        projectRoot: "/tmp/test",
        mode: (overrides.mode as "AUTO" | "NORMAL" | "PLAN") ?? "AUTO",
        contextWindow: 100_000,
        history: [],
        sessionRules: [],
        denialTrail: null,
        compactedThisTurn: false,
        headless: false,
        shapingFlags: {
            budgetReductionApplied: false,
            snipApplied: false,
            microcompactApplied: false,
            collapseApplied: false,
            autoCompactApplied: false,
        },
        globalTurnIndex: 0,
        selectedMemory: null,
        ghostWaitFiredThisPrompt: false,
        ghostWaitSuppressNext: false,
        turnState: {
            fileSeen: new Map(),
            todos: null,
            allowedTools: null,
            projectId: "test-project",
        },
    }) as any;

beforeEach(() => {
    getBackgroundManager(sessionId);
    getBackgroundSubagentManager(sessionId);
});

afterEach(() => {
    destroyBackgroundManager(sessionId);
    destroyBackgroundSubagentManager(sessionId);
    destroyMonitorManager(sessionId);
});

describe("detectGhostWait", () => {
    test("returns reminder when model says wait and nothing is running", () => {
        const result = detectGhostWait("Waiting for the Anthropic provider tests.", [], state());
        expect(result).toBe(GHOST_WAIT_REMINDER);
    });

    test("returns null when model does not mention waiting", () => {
        const result = detectGhostWait("Typecheck passes clean. All good.", [], state());
        expect(result).toBeNull();
    });

    test("returns null when a background bash task is running", () => {
        const mgr = getBackgroundManager(sessionId);
        mgr.start("sleep 10", "/tmp", 10_000, "call-1");
        const result = detectGhostWait("Waiting for the bash task.", [], state());
        expect(result).toBeNull();
    });

    test("returns null when model started a Task this turn", () => {
        const toolCalls = [{ id: "call-1", name: "Task", args: {} }];
        const result = detectGhostWait("Waiting for the subagent.", toolCalls, state());
        expect(result).toBeNull();
    });

    test("returns null when model started background Bash this turn", () => {
        const toolCalls = [
            { id: "call-1", name: "Bash", args: { command: "sleep 1", run_in_background: true } },
        ];
        const result = detectGhostWait("Waiting for the build.", toolCalls, state());
        expect(result).toBeNull();
    });

    test("returns reminder when model started only foreground Bash this turn", () => {
        const toolCalls = [{ id: "call-1", name: "Bash", args: { command: "echo hi" } }];
        const result = detectGhostWait("Waiting for the tests.", toolCalls, state());
        expect(result).toBe(GHOST_WAIT_REMINDER);
    });

    test("returns null in PLAN mode", () => {
        const result = detectGhostWait("Waiting for user approval.", [], state({ mode: "PLAN" }));
        expect(result).toBeNull();
    });

    test("matches 'wait' mid-sentence", () => {
        const result = detectGhostWait("Let me wait for the results to come back.", [], state());
        expect(result).toBe(GHOST_WAIT_REMINDER);
    });

    test("matches 'waiting' in longer text", () => {
        const result = detectGhostWait(
            "Typecheck passes clean. Now let me verify the tests. Waiting for the Anthropic provider tests.",
            [],
            state(),
        );
        expect(result).toBe(GHOST_WAIT_REMINDER);
    });

    test("matches case-insensitively", () => {
        const result = detectGhostWait("I am WAITING for this to finish.", [], state());
        expect(result).toBe(GHOST_WAIT_REMINDER);
    });

    test("catches 'don't wait' as a false positive — acceptable per design", () => {
        // False positive, but the cost is a few tokens of nudge — cheaper than
        // a genuine ghost-wait stall.
        const result = detectGhostWait("Don't wait — just proceed.", [], state());
        // It contains "wait", so it fires. This is documented as acceptable.
        expect(result).toBe(GHOST_WAIT_REMINDER);
    });
});
