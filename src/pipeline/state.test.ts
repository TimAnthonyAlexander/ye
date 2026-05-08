import { describe, expect, test } from "bun:test";
import {
    newShapingFlags,
    newTurnState,
    recordDenial,
    resetDenialTrail,
    type SessionState,
} from "./state.ts";

const makeState = (overrides: Partial<SessionState> = {}): SessionState => ({
    sessionId: "s",
    projectId: "p",
    projectRoot: "/tmp",
    mode: "PLAN",
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

describe("recordDenial / resetDenialTrail", () => {
    test("T1 recordDenial on null trail seeds { tool, count: 1 }", () => {
        const s = makeState();
        expect(s.denialTrail).toBeNull();
        recordDenial(s, "Edit");
        expect(s.denialTrail).toEqual({ tool: "Edit", count: 1 });
    });

    test("T2 recordDenial for the same tool consecutively increments count", () => {
        const s = makeState();
        recordDenial(s, "Edit");
        recordDenial(s, "Edit");
        recordDenial(s, "Edit");
        expect(s.denialTrail).toEqual({ tool: "Edit", count: 3 });
    });

    test("T3 recordDenial for a different tool resets to { newTool, count: 1 }", () => {
        const s = makeState();
        recordDenial(s, "Edit");
        recordDenial(s, "Edit");
        expect(s.denialTrail?.count).toBe(2);
        recordDenial(s, "Bash");
        expect(s.denialTrail).toEqual({ tool: "Bash", count: 1 });
    });

    test("T4 resetDenialTrail clears the trail to null", () => {
        const s = makeState({ denialTrail: { tool: "Edit", count: 2 } });
        resetDenialTrail(s);
        expect(s.denialTrail).toBeNull();
    });

    test("T5 mutation contract: same state reference, only denialTrail changes", () => {
        const s = makeState();
        const before = s;
        recordDenial(s, "Edit");
        expect(s).toBe(before); // same reference (state is mutated, not replaced)
        // Other fields are untouched.
        expect(s.sessionId).toBe("s");
        expect(s.mode).toBe("PLAN");
        expect(s.history).toEqual([]);
    });
});
