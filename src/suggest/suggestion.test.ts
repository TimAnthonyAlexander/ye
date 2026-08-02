import { describe, expect, test } from "bun:test";
import type { Message } from "../providers/types.ts";
import {
    buildSuggestionMessages,
    lastRoleText,
    MAX_SUGGESTION_CHARS,
    NO_SUGGESTION,
    reduceSuggestion,
    sanitizeSuggestion,
    shouldGenerateSuggestion,
    visibleSuggestion,
    type SuggestionGate,
    type SuggestionVisibility,
} from "./suggestion.ts";

describe("sanitizeSuggestion", () => {
    test("returns a plain one-liner unchanged", () => {
        expect(sanitizeSuggestion("run the tests")).toBe("run the tests");
    });

    test("keeps only the first non-empty line", () => {
        expect(sanitizeSuggestion("\n\nrun the tests\nthen commit it\n- or revert")).toBe(
            "run the tests",
        );
    });

    test("collapses tabs and runs of whitespace", () => {
        expect(sanitizeSuggestion("  run\tthe    tests  ")).toBe("run the tests");
    });

    test("strips surrounding quotes", () => {
        expect(sanitizeSuggestion('"run the tests"')).toBe("run the tests");
        expect(sanitizeSuggestion("`run the tests`")).toBe("run the tests");
        expect(sanitizeSuggestion("“run the tests”")).toBe("run the tests");
    });

    test("strips a leading markdown list marker", () => {
        expect(sanitizeSuggestion("- run the tests")).toBe("run the tests");
        expect(sanitizeSuggestion("* run the tests")).toBe("run the tests");
        expect(sanitizeSuggestion("1. run the tests")).toBe("run the tests");
        expect(sanitizeSuggestion("> run the tests")).toBe("run the tests");
    });

    test("strips ESC, BEL and other C0/C1 controls", () => {
        const cleaned = sanitizeSuggestion("run\x1b]0;evil\x07 the tests");
        expect(cleaned).not.toContain("\x1b");
        expect(cleaned).not.toContain("\x07");
        expect(cleaned).toBe("run]0;evil the tests");
        expect(sanitizeSuggestion("run\x7f\x9b tests")).toBe("run tests");
    });

    test("caps length at a word boundary and adds no ellipsis", () => {
        const long = `${"word ".repeat(40)}end`;
        const out = sanitizeSuggestion(long);
        expect(out).not.toBeNull();
        expect(out!.length).toBeLessThanOrEqual(MAX_SUGGESTION_CHARS);
        expect(out!.endsWith("…")).toBe(false);
        expect(out!.endsWith("word")).toBe(true);
    });

    test("hard-cuts a single overlong token", () => {
        const out = sanitizeSuggestion("a".repeat(200));
        expect(out).toBe("a".repeat(MAX_SUGGESTION_CHARS));
    });

    test("returns null for empty, whitespace-only or control-only output", () => {
        expect(sanitizeSuggestion("")).toBeNull();
        expect(sanitizeSuggestion("   \n\t  ")).toBeNull();
        expect(sanitizeSuggestion("\x00\x01\x02")).toBeNull();
        expect(sanitizeSuggestion('""')).toBeNull();
    });
});

const gate = (over: Partial<SuggestionGate> = {}): SuggestionGate => ({
    enabled: true,
    chainFailed: false,
    streaming: false,
    showing: false,
    lastUserPrompt: "fix the login bug",
    ...over,
});

describe("shouldGenerateSuggestion", () => {
    test("generates after a clean chain", () => {
        expect(shouldGenerateSuggestion(gate())).toBe(true);
    });

    test("skips when suggestions are not enabled", () => {
        expect(shouldGenerateSuggestion(gate({ enabled: false }))).toBe(false);
    });

    test("skips when the chain failed or was cancelled", () => {
        expect(shouldGenerateSuggestion(gate({ chainFailed: true }))).toBe(false);
    });

    test("skips while a turn is streaming", () => {
        expect(shouldGenerateSuggestion(gate({ streaming: true }))).toBe(false);
    });

    test("skips when a suggestion is already showing", () => {
        expect(shouldGenerateSuggestion(gate({ showing: true }))).toBe(false);
    });

    test("skips when there is no user prompt to condition on", () => {
        expect(shouldGenerateSuggestion(gate({ lastUserPrompt: "" }))).toBe(false);
    });
});

describe("buildSuggestionMessages", () => {
    test("sends only the last user message and the tail of the reply", () => {
        const messages = buildSuggestionMessages("fix the login bug", `${"x".repeat(4000)}DONE`);
        expect(messages).toHaveLength(2);
        expect(messages[0]?.role).toBe("system");
        const user = messages[1]?.content ?? "";
        expect(user).toContain("fix the login bug");
        expect(user).toContain("DONE");
        expect(user.length).toBeLessThan(2600);
    });
});

describe("lastRoleText", () => {
    const history: readonly Message[] = [
        { role: "user", content: "first ask" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second ask" },
        { role: "assistant", content: null, tool_calls: [] },
        { role: "tool", content: "tool output" },
        { role: "assistant", content: "   " },
    ];

    test("returns the newest non-empty message for the role", () => {
        expect(lastRoleText(history, "user")).toBe("second ask");
        expect(lastRoleText(history, "assistant")).toBe("first answer");
    });

    test("returns an empty string when the role never spoke", () => {
        expect(lastRoleText([], "user")).toBe("");
    });
});

const vis = (over: Partial<SuggestionVisibility> = {}): SuggestionVisibility => ({
    suggestion: "run the tests",
    buffer: "",
    mentionOpen: false,
    searching: false,
    disabled: false,
    ...over,
});

describe("visibleSuggestion", () => {
    test("shows in an empty idle input", () => {
        expect(visibleSuggestion(vis())).toBe("run the tests");
    });

    test("hides when there is nothing to suggest", () => {
        expect(visibleSuggestion(vis({ suggestion: null }))).toBeNull();
        expect(visibleSuggestion(vis({ suggestion: "" }))).toBeNull();
    });

    test("hides once the buffer has content, slash commands included", () => {
        expect(visibleSuggestion(vis({ buffer: "r" }))).toBeNull();
        expect(visibleSuggestion(vis({ buffer: "/mo" }))).toBeNull();
    });

    test("hides for the mention picker, reverse-search and a disabled input", () => {
        expect(visibleSuggestion(vis({ mentionOpen: true }))).toBeNull();
        expect(visibleSuggestion(vis({ searching: true }))).toBeNull();
        expect(visibleSuggestion(vis({ disabled: true }))).toBeNull();
    });
});

describe("reduceSuggestion", () => {
    test("shows a suggestion when none is pending", () => {
        expect(reduceSuggestion(NO_SUGGESTION, { type: "show", text: "run the tests" })).toEqual({
            text: "run the tests",
        });
    });

    test("a late arrival never replaces a showing suggestion", () => {
        const showing = { text: "run the tests" };
        expect(reduceSuggestion(showing, { type: "show", text: "commit it" })).toBe(showing);
    });

    test("accept, dismiss and send all clear it", () => {
        const showing = { text: "run the tests" };
        expect(reduceSuggestion(showing, { type: "accept" })).toEqual(NO_SUGGESTION);
        expect(reduceSuggestion(showing, { type: "dismiss" })).toEqual(NO_SUGGESTION);
        expect(reduceSuggestion(showing, { type: "send" })).toEqual(NO_SUGGESTION);
    });

    test("clearing an empty state is identity", () => {
        expect(reduceSuggestion(NO_SUGGESTION, { type: "dismiss" })).toBe(NO_SUGGESTION);
    });
});
