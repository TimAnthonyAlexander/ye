import { describe, expect, test } from "bun:test";
import { evaluateStop } from "./stop.ts";
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
