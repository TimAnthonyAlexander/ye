import { describe, expect, test } from "bun:test";
import { cycleMatch, highlightMatch, previewEntry, searchHistory } from "./historySearch.ts";

// Newest-first, the shape loadHistory() returns.
const HISTORY: readonly string[] = [
    "fix the Login bug",
    "run bun test",
    "add a login test",
    "run bun test",
    "unrelated prompt",
];

describe("searchHistory", () => {
    test("returns every entry for an empty query", () => {
        expect(searchHistory(HISTORY, "")).toEqual([
            "fix the Login bug",
            "run bun test",
            "add a login test",
            "unrelated prompt",
        ]);
    });

    test("matches case-insensitive substrings", () => {
        expect(searchHistory(HISTORY, "login")).toEqual(["fix the Login bug", "add a login test"]);
    });

    test("preserves most-recent-first order", () => {
        expect(searchHistory(HISTORY, "test")).toEqual(["run bun test", "add a login test"]);
    });

    test("collapses repeated entries to the newest occurrence", () => {
        expect(searchHistory(HISTORY, "bun")).toEqual(["run bun test"]);
    });

    test("returns nothing when the query matches no entry", () => {
        expect(searchHistory(HISTORY, "deploy")).toEqual([]);
    });

    test("returns nothing for empty history", () => {
        expect(searchHistory([], "anything")).toEqual([]);
    });
});

describe("cycleMatch", () => {
    test("advances to the next match", () => {
        expect(cycleMatch(3, 0)).toBe(1);
        expect(cycleMatch(3, 1)).toBe(2);
    });

    test("wraps around at the end", () => {
        expect(cycleMatch(3, 2)).toBe(0);
    });

    test("stays at 0 with a single match", () => {
        expect(cycleMatch(1, 0)).toBe(0);
    });

    test("stays at 0 with no matches", () => {
        expect(cycleMatch(0, 0)).toBe(0);
    });
});

describe("previewEntry", () => {
    test("collapses newlines and runs of whitespace onto one line", () => {
        expect(previewEntry("first line\n\n  second   line ")).toBe("first line second line");
    });
});

describe("highlightMatch", () => {
    test("splits around the first case-insensitive hit", () => {
        expect(highlightMatch("fix the Login bug", "login")).toEqual({
            before: "fix the ",
            hit: "Login",
            after: " bug",
        });
    });

    test("returns the whole text unsplit for an empty query", () => {
        expect(highlightMatch("hello", "")).toEqual({ before: "hello", hit: "", after: "" });
    });

    test("returns the whole text unsplit when there is no hit", () => {
        expect(highlightMatch("hello", "zzz")).toEqual({ before: "hello", hit: "", after: "" });
    });
});
