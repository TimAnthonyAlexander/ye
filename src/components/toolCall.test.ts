/**
 * Tests for toolCall.tsx pure logic.
 *
 * Ink 5 renders to terminal output and does not ship a headless test renderer.
 * We test the exported pure functions directly using Bun's built-in test runner.
 */

import { describe, expect, test } from "bun:test";
import { summarizeArgs } from "./toolCall.tsx";

describe("summarizeArgs", () => {
    // --- Bash ---------------------------------------------------------------
    test("Bash: returns the command string", () => {
        expect(summarizeArgs("Bash", { command: "npm test" })).toBe("npm test");
    });

    test("Bash: empty string for missing command", () => {
        expect(summarizeArgs("Bash", {})).toBe("");
    });

    test("Bash: empty string for null args", () => {
        expect(summarizeArgs("Bash", null)).toBe("");
    });

    test("Bash: empty string for non-object args", () => {
        expect(summarizeArgs("Bash", "not an object")).toBe("");
    });

    // --- Read ---------------------------------------------------------------
    test("Read: returns pretty-pathed path", () => {
        const cwd = process.cwd();
        const result = summarizeArgs("Read", { path: `${cwd}/src/bar.ts` });
        expect(result).toBe("src/bar.ts");
    });

    test("Read: empty string for missing path", () => {
        expect(summarizeArgs("Read", {})).toBe("");
    });

    // --- Write --------------------------------------------------------------
    test("Write: returns pretty-pathed path", () => {
        const result = summarizeArgs("Write", { path: "/tmp/file.txt" });
        // prettyPath shortens relative to cwd or home; on most systems /tmp is
        // outside both, so it stays as-is.
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
    });

    test("Write: empty string for missing path", () => {
        expect(summarizeArgs("Write", {})).toBe("");
    });

    // --- Edit ---------------------------------------------------------------
    test("Edit: returns pretty-pathed path", () => {
        const cwd = process.cwd();
        const result = summarizeArgs("Edit", { path: `${cwd}/src/bar.ts` });
        expect(result).toBe("src/bar.ts");
    });

    // --- Glob ---------------------------------------------------------------
    test("Glob: returns the pattern string", () => {
        expect(summarizeArgs("Glob", { pattern: "*.ts" })).toBe("*.ts");
    });

    test("Glob: empty string for missing pattern", () => {
        expect(summarizeArgs("Glob", {})).toBe("");
    });

    // --- Grep --------------------------------------------------------------
    test("Grep: returns the pattern string", () => {
        expect(summarizeArgs("Grep", { pattern: "TODO" })).toBe("TODO");
    });

    test("Grep: empty string for missing pattern", () => {
        expect(summarizeArgs("Grep", {})).toBe("");
    });

    // --- AskUserQuestion ----------------------------------------------------
    test("AskUserQuestion: returns the question string", () => {
        expect(summarizeArgs("AskUserQuestion", { question: "Choose one" })).toBe("Choose one");
    });

    test("AskUserQuestion: empty string for missing question", () => {
        expect(summarizeArgs("AskUserQuestion", {})).toBe("");
    });

    // --- Task ---------------------------------------------------------------
    test("Task: returns kind: prompt when both present", () => {
        expect(summarizeArgs("Task", { kind: "explore", prompt: "find bugs" })).toBe(
            "explore: find bugs",
        );
    });

    test("Task: returns prompt only when kind is missing", () => {
        expect(summarizeArgs("Task", { prompt: "find bugs" })).toBe("find bugs");
    });

    test("Task: returns empty string when both missing", () => {
        expect(summarizeArgs("Task", {})).toBe("");
    });

    // --- Unknown tools -----------------------------------------------------
    test("UnknownTool: returns empty string", () => {
        expect(summarizeArgs("UnknownTool", { x: 1 })).toBe("");
    });
});
