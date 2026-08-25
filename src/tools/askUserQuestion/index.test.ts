import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../types.ts";
import { AskUserQuestionTool, type UserQuestionResult } from "./index.ts";

const ctx = {} as ToolContext;

const run = async (args: unknown) => AskUserQuestionTool.execute(args, ctx);

describe("AskUserQuestion", () => {
    test("Q1 takes Ye's single-question shape", async () => {
        const r = await run({
            question: "Which one?",
            options: ["A", { label: "B", description: "the other" }],
        });
        expect(r.ok).toBe(true);
        const value = r.ok === true ? (r.value as UserQuestionResult) : null;
        expect(value?.questions).toEqual([
            {
                question: "Which one?",
                options: [{ label: "A" }, { label: "B", description: "the other" }],
                multiSelect: false,
            },
        ]);
    });

    // Claude Code's AskUserQuestion takes an array, so a Claude model hands us
    // one whichever schema it read. The pipeline asks them in sequence.
    test("Q2 takes Claude Code's questions array", async () => {
        const r = await run({
            questions: [
                {
                    header: "Scope",
                    question: "How far?",
                    options: [{ label: "A" }, { label: "B" }],
                },
                {
                    question: "Which stack?",
                    options: [{ label: "C" }, { label: "D" }],
                    multiSelect: true,
                },
            ],
        });
        expect(r.ok).toBe(true);
        const value = r.ok === true ? (r.value as UserQuestionResult) : null;
        expect(value?.questions.map((q) => q.question)).toEqual(["How far?", "Which stack?"]);
        expect(value?.questions[1]?.multiSelect).toBe(true);
    });

    test("Q3 reports which question in the array is malformed", async () => {
        const r = await run({
            questions: [
                { question: "ok", options: [{ label: "A" }, { label: "B" }] },
                { question: "too few", options: [{ label: "A" }] },
            ],
        });
        expect(r.ok === false && r.error).toBe(
            "question 2: options must have between 2 and 4 entries",
        );
    });

    test("Q4 names both shapes when neither arrived", async () => {
        const r = await run({ prompt: "what now" });
        expect(r.ok === false && r.error).toContain("either {question, options}");
    });
});
