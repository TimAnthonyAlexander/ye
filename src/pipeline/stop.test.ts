import { describe, expect, test } from "bun:test";
import { evaluateStop, PLAN_START_REMINDER, shouldNudgePlanStart } from "./stop.ts";
import { newShapingFlags, newTurnState, type DenialTrail, type SessionState } from "./state.ts";

const makeState = (overrides: Partial<SessionState> = {}): SessionState => ({
    sessionId: "s",
    projectId: "p",
    projectRoot: "/tmp",
    mode: "NORMAL",
    contextWindow: 100_000,
    history: [],
    sessionRules: [],
    denialTrail: null,
    compactedThisTurn: false,
    shapingFlags: newShapingFlags(),
    globalTurnIndex: 0,
    selectedMemory: null,
    headless: false,
    turnState: newTurnState(),
    ...overrides,
});

const trail = (tool: string, count: number): DenialTrail => ({ tool, count });

describe("evaluateStop", () => {
    test("S1 no tool calls in the last assistant message → end_turn", () => {
        const r = evaluateStop({
            state: makeState(),
            turnIndex: 0,
            maxTurns: 100,
            hadToolCalls: false,
        });
        expect(r).toBe("end_turn");
    });

    test("S2 tool calls present, under maxTurns → null (continue)", () => {
        const r = evaluateStop({
            state: makeState(),
            turnIndex: 0,
            maxTurns: 100,
            hadToolCalls: true,
        });
        expect(r).toBeNull();
    });

    test("S3 tool calls present at the maxTurns boundary → max_turns", () => {
        // turnIndex + 1 >= maxTurns ⇒ guard fires
        const r = evaluateStop({
            state: makeState(),
            turnIndex: 99,
            maxTurns: 100,
            hadToolCalls: true,
        });
        expect(r).toBe("max_turns");
    });

    test("S4 PLAN + denialTrail count = 1 → does NOT fire guard (continue)", () => {
        const r = evaluateStop({
            state: makeState({ mode: "PLAN", denialTrail: trail("Edit", 1) }),
            turnIndex: 0,
            maxTurns: 100,
            hadToolCalls: true,
        });
        expect(r).toBeNull();
    });

    test("S5 PLAN + denialTrail count >= 2 → plan_loop_guard (byte-equal)", () => {
        const r = evaluateStop({
            state: makeState({ mode: "PLAN", denialTrail: trail("Edit", 2) }),
            turnIndex: 0,
            maxTurns: 100,
            hadToolCalls: true,
        });
        expect(r).toBe("plan_loop_guard");
    });

    test("S6 NORMAL + denialTrail count >= 2 → guard does NOT fire (PLAN-only)", () => {
        const r = evaluateStop({
            state: makeState({ mode: "NORMAL", denialTrail: trail("Edit", 5) }),
            turnIndex: 0,
            maxTurns: 100,
            hadToolCalls: false,
        });
        expect(r).toBe("end_turn");
    });

    test("S7 PLAN + denialTrail null → guard does NOT fire", () => {
        const r = evaluateStop({
            state: makeState({ mode: "PLAN", denialTrail: null }),
            turnIndex: 0,
            maxTurns: 100,
            hadToolCalls: false,
        });
        expect(r).toBe("end_turn");
    });

    test("S8 plan_loop_guard takes precedence over max_turns", () => {
        const r = evaluateStop({
            state: makeState({ mode: "PLAN", denialTrail: trail("Edit", 2) }),
            turnIndex: 99,
            maxTurns: 100,
            hadToolCalls: true,
        });
        expect(r).toBe("plan_loop_guard");
    });
});

describe("shouldNudgePlanStart", () => {
    test("N1 plan just approved + text-only end_turn → nudge", () => {
        expect(shouldNudgePlanStart(true, "end_turn")).toBe(true);
    });

    test("N2 plan just approved but the model started working (continue) → no nudge", () => {
        expect(shouldNudgePlanStart(true, "continue")).toBe(false);
    });

    test("N3 plan just approved + max_turns → no nudge (real budget stop)", () => {
        expect(shouldNudgePlanStart(true, "max_turns")).toBe(false);
    });

    test("N4 no recent approval + text-only end_turn → no nudge (ordinary stop)", () => {
        expect(shouldNudgePlanStart(false, "end_turn")).toBe(false);
    });

    test("N5 reminder is a system-reminder that tells the model to start", () => {
        expect(PLAN_START_REMINDER).toContain("<system-reminder>");
        expect(PLAN_START_REMINDER.toLowerCase()).toContain("begin executing");
    });
});
