import { describe, expect, test } from "bun:test";
import type { PermissionRule } from "../config/index.ts";
import { PLAN_ALLOWED } from "../permissions/index.ts";
import { assembleToolPool } from "./pool.ts";
import { listTools } from "./registry.ts";

const names = (pool: ReadonlyArray<{ name: string }>): string[] => pool.map((t) => t.name);
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe("assembleToolPool", () => {
    test("P1 NORMAL pool contains every registered tool except ExitPlanMode (PLAN-only)", () => {
        const pool = assembleToolPool({ mode: "NORMAL", rules: [] });
        const expected = sorted(
            listTools()
                .map((t) => t.name)
                .filter((n) => n !== "ExitPlanMode"),
        );
        expect(sorted(names(pool))).toEqual(expected);
        expect(names(pool)).not.toContain("ExitPlanMode");
        expect(names(pool)).toContain("EnterPlanMode");
    });

    test("P2 PLAN pool contains exactly the PLAN_ALLOWED set (intersected with registry)", () => {
        const pool = assembleToolPool({ mode: "PLAN", rules: [] });
        const expected = sorted(
            listTools()
                .map((t) => t.name)
                .filter((n) => PLAN_ALLOWED.includes(n)),
        );
        expect(sorted(names(pool))).toEqual(expected);
        // No state-modifying tool slips through.
        for (const banned of ["Edit", "Write", "Bash", "TodoWrite", "Task", "EnterPlanMode"]) {
            expect(names(pool)).not.toContain(banned);
        }
    });

    test("P3 blanket-deny rule on Bash removes Bash from the pool", () => {
        const rules: PermissionRule[] = [{ effect: "deny", tool: "Bash" }];
        const pool = assembleToolPool({ mode: "NORMAL", rules });
        expect(names(pool)).not.toContain("Bash");
        // Other tools still present.
        expect(names(pool)).toContain("Read");
    });

    test("P4 pattern-deny on Bash(rm:*) does NOT pre-filter Bash from the pool", () => {
        const rules: PermissionRule[] = [{ effect: "deny", tool: "Bash", pattern: "Bash(rm:*)" }];
        const pool = assembleToolPool({ mode: "NORMAL", rules });
        // Pattern denies are evaluated per-call by decide(), not by the pool.
        expect(names(pool)).toContain("Bash");
    });

    test("P5 allowedTools narrowing limits the pool (subagent surface)", () => {
        const allowedTools = ["Read", "Glob", "Grep"];
        const pool = assembleToolPool({ mode: "AUTO", rules: [], allowedTools });
        expect(sorted(names(pool))).toEqual(sorted(allowedTools));
        // Task is excluded — recursion guard is structural.
        expect(names(pool)).not.toContain("Task");
    });

    test("P6 capability filter drops WebSearch when webSearchAvailable is false", () => {
        const withSearch = assembleToolPool({
            mode: "AUTO",
            rules: [],
            webSearchAvailable: true,
        });
        const withoutSearch = assembleToolPool({
            mode: "AUTO",
            rules: [],
            webSearchAvailable: false,
        });
        expect(names(withSearch)).toContain("WebSearch");
        expect(names(withoutSearch)).not.toContain("WebSearch");
    });

    test("P8 ExitPlanMode is dropped from NORMAL and AUTO pools (PLAN-only tool)", () => {
        for (const mode of ["NORMAL", "AUTO"] as const) {
            const pool = assembleToolPool({ mode, rules: [] });
            expect(names(pool)).not.toContain("ExitPlanMode");
        }
        // And of course it IS in PLAN.
        expect(names(assembleToolPool({ mode: "PLAN", rules: [] }))).toContain("ExitPlanMode");
    });

    test("P7 deduplication: a tool is never returned twice", () => {
        const pool = assembleToolPool({ mode: "NORMAL", rules: [] });
        const seen = new Set<string>();
        for (const t of pool) {
            expect(seen.has(t.name)).toBe(false);
            seen.add(t.name);
        }
    });

    test("P9 headless drops AskUserQuestion and EnterPlanMode", () => {
        const pool = assembleToolPool({ mode: "AUTO", rules: [], headless: true });
        expect(names(pool)).not.toContain("AskUserQuestion");
        expect(names(pool)).not.toContain("EnterPlanMode");
        expect(names(pool)).toContain("Read");
        // ExitPlanMode is dropped in AUTO regardless; headless shouldn't add it back.
        expect(names(pool)).not.toContain("ExitPlanMode");
    });
});
