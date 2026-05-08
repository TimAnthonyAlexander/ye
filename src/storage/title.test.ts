import { describe, expect, test } from "bun:test";
import { sanitizeTitle, titleModelFor } from "./title.ts";

describe("sanitizeTitle", () => {
    test("returns plain titles unchanged", () => {
        expect(sanitizeTitle("Fix login button")).toBe("Fix login button");
    });

    test("collapses internal whitespace", () => {
        expect(sanitizeTitle("Fix    login\tbutton\nbug")).toBe("Fix login button bug");
    });

    test("trims surrounding quotes and trailing periods", () => {
        expect(sanitizeTitle('"Fix login button."')).toBe("Fix login button");
        expect(sanitizeTitle("'Resume picker'")).toBe("Resume picker");
        expect(sanitizeTitle("“Smart quotes”")).toBe("Smart quotes");
    });

    test("strips C0 control characters including ESC and BEL", () => {
        const escInjection = `Title\x1b]0;evil\x07`;
        const cleaned = sanitizeTitle(escInjection);
        expect(cleaned).not.toContain("\x1b");
        expect(cleaned).not.toContain("\x07");
        expect(cleaned).toBe("Title]0;evil");
    });

    test("strips DEL and C1 controls", () => {
        const c1 = `Title\x7f\x9b\x9d`;
        expect(sanitizeTitle(c1)).toBe("Title");
    });

    test("preserves Unicode letters and dashes", () => {
        expect(sanitizeTitle("Café résumé — note")).toBe("Café résumé — note");
    });

    test("returns empty string when input is whitespace or controls only", () => {
        expect(sanitizeTitle("   ")).toBe("");
        expect(sanitizeTitle("\x00\x01\x02")).toBe("");
    });

    test("hard-caps overlong titles with ellipsis", () => {
        const long = "a".repeat(120);
        const out = sanitizeTitle(long);
        expect(out.length).toBeLessThanOrEqual(60);
        expect(out.endsWith("…")).toBe(true);
    });
});

describe("titleModelFor", () => {
    test("returns gemini flash for openrouter", () => {
        expect(titleModelFor("openrouter")).toBe("~google/gemini-flash-latest");
    });

    test("returns haiku 4.5 for anthropic", () => {
        expect(titleModelFor("anthropic")).toBe("claude-haiku-4-5");
    });

    test("returns null for unknown providers", () => {
        expect(titleModelFor("local")).toBeNull();
        expect(titleModelFor("")).toBeNull();
    });
});
