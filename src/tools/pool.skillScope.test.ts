import { describe, expect, test } from "bun:test";
import type { PermissionRule } from "../config/index.ts";
import { assembleToolPool, narrowAllowedTools } from "./pool.ts";

const names = (pool: ReadonlyArray<{ name: string }>): string[] => pool.map((t) => t.name);
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe("skill-scoped tool pool", () => {
    test("a skill allowlist narrows the pool to exactly that list", () => {
        const pool = assembleToolPool({
            mode: "AUTO",
            rules: [],
            allowedTools: ["Read", "Grep", "Bash"],
        });
        expect(sorted(names(pool))).toEqual(["Bash", "Grep", "Read"]);
    });

    test("disallowedTools subtracts from the pool it would otherwise be", () => {
        const full = assembleToolPool({ mode: "AUTO", rules: [] });
        const pool = assembleToolPool({
            mode: "AUTO",
            rules: [],
            disallowedTools: ["Bash", "Write"],
        });
        expect(names(pool)).not.toContain("Bash");
        expect(names(pool)).not.toContain("Write");
        expect(names(pool)).toContain("Read");
        expect(pool).toHaveLength(full.length - 2);
    });

    test("disallowedTools applies on top of an allowlist", () => {
        const pool = assembleToolPool({
            mode: "AUTO",
            rules: [],
            allowedTools: ["Read", "Grep", "Bash"],
            disallowedTools: ["Bash"],
        });
        expect(sorted(names(pool))).toEqual(["Grep", "Read"]);
    });

    test("disallowing a tool that isn't in the pool is a no-op", () => {
        const pool = assembleToolPool({
            mode: "AUTO",
            rules: [],
            allowedTools: ["Read"],
            disallowedTools: ["Bash", "NotATool"],
        });
        expect(names(pool)).toEqual(["Read"]);
    });

    test("an allowlist never widens past the PLAN allowlist", () => {
        const pool = assembleToolPool({
            mode: "PLAN",
            rules: [],
            allowedTools: ["Read", "Bash", "Edit", "Write", "BashOutput", "TaskOutput"],
        });
        expect(names(pool)).toEqual(["Read"]);
        for (const banned of ["Bash", "Edit", "Write", "BashOutput", "TaskOutput"]) {
            expect(names(pool)).not.toContain(banned);
        }
    });

    test("an allowlist never re-adds a blanket-denied tool", () => {
        const rules: PermissionRule[] = [{ effect: "deny", tool: "Bash" }];
        const pool = assembleToolPool({ mode: "AUTO", rules, allowedTools: ["Read", "Bash"] });
        expect(names(pool)).toEqual(["Read"]);
    });

    test("an allowlist never re-adds tools dropped by capability or headless filters", () => {
        const pool = assembleToolPool({
            mode: "AUTO",
            rules: [],
            allowedTools: ["Read", "WebSearch", "AskUserQuestion"],
            webSearchAvailable: false,
            headless: true,
        });
        expect(names(pool)).toEqual(["Read"]);
    });

    test("an unknown tool name in an allowlist yields nothing", () => {
        const pool = assembleToolPool({ mode: "AUTO", rules: [], allowedTools: ["NotATool"] });
        expect(pool).toHaveLength(0);
    });
});

describe("narrowAllowedTools", () => {
    test("passes either side through when the other is absent", () => {
        expect(narrowAllowedTools(undefined, undefined)).toBeUndefined();
        expect(narrowAllowedTools(["Read"], undefined)).toEqual(["Read"]);
        expect(narrowAllowedTools(undefined, ["Read"])).toEqual(["Read"]);
    });

    test("intersects two lists", () => {
        expect(narrowAllowedTools(["Read", "Glob", "Grep"], ["Read", "Grep"])).toEqual([
            "Read",
            "Grep",
        ]);
    });

    test("a skill cannot re-add a tool the surrounding subagent scope excluded", () => {
        const subagentScope = ["Read", "Glob", "Grep"];
        const skillScope = ["Read", "Bash", "Edit"];
        const combined = narrowAllowedTools(subagentScope, skillScope);
        expect(combined).toEqual(["Read"]);
        expect(
            names(assembleToolPool({ mode: "AUTO", rules: [], allowedTools: combined })),
        ).toEqual(["Read"]);
    });

    test("disjoint lists collapse to an empty pool rather than a union", () => {
        expect(narrowAllowedTools(["Read"], ["Bash"])).toEqual([]);
        expect(
            assembleToolPool({ mode: "AUTO", rules: [], allowedTools: [] as readonly string[] }),
        ).toHaveLength(0);
    });
});
