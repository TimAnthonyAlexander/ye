/**
 * Tests for parseIndexResponse — the pure function that extracts 1-based
 * indices from LLM text responses.
 *
 * selectMemoryFiles and ensureSelectedMemory require LLM calls and are tested
 * via integration; readAllMemoryIndices requires filesystem setup.
 */

import { describe, expect, test } from "bun:test";
import { parseIndexResponse } from "../memory/select.ts";

describe("parseIndexResponse", () => {
    // ── empty / no-match ──────────────────────────────────────────

    test("empty text returns empty array", () => {
        expect(parseIndexResponse("", 10, 5)).toEqual([]);
    });

    test("text with no bracket returns empty array", () => {
        expect(parseIndexResponse("just some prose here", 10, 5)).toEqual([]);
    });

    test("empty brackets [] returns empty array", () => {
        expect(parseIndexResponse("[]", 10, 5)).toEqual([]);
    });

    test("brackets with only spaces [ ] returns empty array", () => {
        expect(parseIndexResponse("[ ]", 10, 5)).toEqual([]);
    });

    test("brackets with no digits [abc] returns empty array", () => {
        expect(parseIndexResponse("[abc]", 10, 5)).toEqual([]);
    });

    test("only commas [,,] returns empty array", () => {
        expect(parseIndexResponse("[,,]", 10, 5)).toEqual([]);
    });

    // ── basic parsing ──────────────────────────────────────────────

    test("single index [1] returns [1]", () => {
        expect(parseIndexResponse("[1]", 10, 5)).toEqual([1]);
    });

    test("multiple indices [1, 3, 5] returns [1, 3, 5]", () => {
        expect(parseIndexResponse("[1, 3, 5]", 10, 5)).toEqual([1, 3, 5]);
    });

    test("spacing variations [ 1 , 2 ] return [1, 2]", () => {
        expect(parseIndexResponse("[ 1 , 2 ]", 10, 5)).toEqual([1, 2]);
    });

    test("extra spacing [  1 , 2  ] returns [1, 2]", () => {
        expect(parseIndexResponse("[  1 , 2  ]", 10, 5)).toEqual([1, 2]);
    });

    // ── max capping ────────────────────────────────────────────────

    test("max=2 caps [1, 3, 5] to [1, 3]", () => {
        expect(parseIndexResponse("[1, 3, 5]", 10, 2)).toEqual([1, 3]);
    });

    test("max=1 caps [1, 2] to [1]", () => {
        expect(parseIndexResponse("[1, 2]", 10, 1)).toEqual([1]);
    });

    test("max=0 — push happens before break, so first index is still emitted", () => {
        // The break check `out.length >= max` runs AFTER push, so max=0
        // still lets one element through before breaking.
        expect(parseIndexResponse("[1, 2]", 10, 0)).toEqual([1]);
    });

    test("large indices list capped by max=3", () => {
        expect(parseIndexResponse("[1,2,3,4,5,6,7,8,9,10]", 20, 3)).toEqual([1, 2, 3]);
    });

    // ── count bounds ───────────────────────────────────────────────

    test("index > count is skipped", () => {
        expect(parseIndexResponse("[1, 2, 3]", 2, 5)).toEqual([1, 2]);
    });

    test("index 0 is skipped (1-based)", () => {
        expect(parseIndexResponse("[0, 1, 999]", 5, 5)).toEqual([1]);
    });

    test("all indices out of range when count=0 returns empty", () => {
        expect(parseIndexResponse("[1]", 0, 5)).toEqual([]);
    });

    test("index equal to count is valid (upper bound is inclusive)", () => {
        expect(parseIndexResponse("[5]", 5, 5)).toEqual([5]);
    });

    test("negative sign causes regex mismatch — returns empty", () => {
        // The regex \d+ does not match a leading minus sign, so [-1, 1]
        // fails to match INDEX_RE entirely and returns [].
        expect(parseIndexResponse("[-1, 1]", 5, 5)).toEqual([]);
    });

    // ── deduplication ──────────────────────────────────────────────

    test("duplicate indices are de-duplicated", () => {
        expect(parseIndexResponse("[1, 1, 2]", 5, 5)).toEqual([1, 2]);
    });

    test("triple duplicate returns single entry", () => {
        expect(parseIndexResponse("[3, 3, 3]", 5, 5)).toEqual([3]);
    });

    // ── non-digit tokens inside brackets ────────────────────────────
    //
    // INDEX_RE requires every comma-separated token to be pure \d+.
    // Any non-digit character inside the brackets causes the entire
    // regex to fail, producing [].

    test("non-digit tokens like abc cause regex mismatch — returns empty", () => {
        expect(parseIndexResponse("[1, abc, 3]", 5, 5)).toEqual([]);
    });

    test("float values like 1.5 cause regex mismatch — returns empty", () => {
        expect(parseIndexResponse("[1.5, 2]", 5, 5)).toEqual([]);
    });

    test("hex values like 0xA cause regex mismatch — returns empty", () => {
        // The 'x' and 'A' are not matched by \d, so the regex fails.
        expect(parseIndexResponse("[0xA, 1]", 5, 5)).toEqual([]);
    });

    // ── prose around brackets ──────────────────────────────────────

    test("prose before the array is ignored", () => {
        expect(parseIndexResponse("Here's my selection: [1, 2] and that's it", 5, 5)).toEqual([
            1, 2,
        ]);
    });

    test("prose after the array is ignored", () => {
        expect(parseIndexResponse("[1, 2] is my answer", 5, 5)).toEqual([1, 2]);
    });

    test("newlines before the array are ignored", () => {
        expect(parseIndexResponse("Some text\n[1,2]\nmore text", 5, 5)).toEqual([1, 2]);
    });

    // ── multiple bracket expressions ───────────────────────────────

    test("multiple brackets — only the first is used", () => {
        expect(parseIndexResponse("[1,2] [3,4]", 5, 5)).toEqual([1, 2]);
    });

    test("second bracket ignored even if first has fewer valid indices", () => {
        expect(parseIndexResponse("[1,2] [3,4,5]", 5, 2)).toEqual([1, 2]);
    });

    // ── trailing / leading commas (regex edge cases) ───────────────

    test("trailing comma [1,2,] — regex does not match, returns empty", () => {
        expect(parseIndexResponse("[1,2,]", 5, 5)).toEqual([]);
    });

    test("leading comma [,1,2] — regex does not match, returns empty", () => {
        expect(parseIndexResponse("[,1,2]", 5, 5)).toEqual([]);
    });

    // ── return type is a plain array ───────────────────────────────

    test("return value is an array", () => {
        expect(Array.isArray(parseIndexResponse("[1, 2]", 5, 5))).toBe(true);
    });

    // ── partial matches / real-world patterns ──────────────────────

    test("index reference embedded in markdown-like text", () => {
        const text = "I recommend checking indices [1, 4] for your query about memory.";
        expect(parseIndexResponse(text, 5, 5)).toEqual([1, 4]);
    });

    test("single index in prose", () => {
        expect(parseIndexResponse("The answer is [3]", 5, 5)).toEqual([3]);
    });
});
