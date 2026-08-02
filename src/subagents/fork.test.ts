import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import type { Message } from "../providers/index.ts";
import { copyForkHistory, resolveAgent } from "./index.ts";
import { GENERAL_TOOLS } from "./kinds/general.ts";

const call = (id: string): Message["tool_calls"] => [
    { id, type: "function", function: { name: "Read", arguments: "{}" } },
];

const parentHistory: readonly Message[] = [
    { role: "user", content: "add a flag" },
    { role: "assistant", content: "reading first", tool_calls: call("c1") },
    { role: "tool", tool_call_id: "c1", content: "file body" },
    { role: "assistant", content: "the flag lives in cli.tsx" },
];

let root: string;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ye-fork-"));
});

const resolveFork = (seedHistory: readonly Message[], budget = 25) =>
    resolveAgent({ kind: "fork", prompt: "write the changelog entry", seedHistory }, root, budget);

describe("fork", () => {
    test("seeds its history from the parent conversation", () => {
        expect(resolveFork(parentHistory).seedHistory).toEqual(parentHistory);
    });

    test("the seed is a deep copy — mutating it leaves the parent untouched", () => {
        const seed = resolveFork(parentHistory).seedHistory;
        expect(seed[0]).not.toBe(parentHistory[0]);
        expect(seed[1]?.tool_calls?.[0]).not.toBe(parentHistory[1]?.tool_calls?.[0]);

        (seed as Message[])[0] = { role: "user", content: "rewritten" };
        (seed[1]?.tool_calls?.[0]?.function as { name: string }).name = "Bash";

        expect(parentHistory[0]?.content).toBe("add a flag");
        expect(parentHistory[1]?.tool_calls?.[0]?.function.name).toBe("Read");
    });

    test("drops a trailing tool call whose result has not landed yet", () => {
        const midTurn: readonly Message[] = [
            ...parentHistory,
            { role: "user", content: "now fork" },
            { role: "assistant", content: "forking", tool_calls: call("c2") },
        ];
        expect(resolveFork(midTurn).seedHistory).toEqual([
            ...parentHistory,
            { role: "user", content: "now fork" },
        ]);
    });

    test("keeps a completed call/result pair whole", () => {
        const complete: readonly Message[] = [
            { role: "user", content: "hi" },
            { role: "assistant", content: "working", tool_calls: call("c9") },
            { role: "tool", tool_call_id: "c9", content: "ok" },
        ];
        expect(copyForkHistory(complete)).toEqual([...complete]);
    });

    test("cannot spawn a Task, so a fork cannot fork", () => {
        const tools = resolveFork(parentHistory).allowedTools;
        expect(tools).toEqual(GENERAL_TOOLS);
        expect(tools).not.toContain("Task");
    });

    test("its turn budget is general's, still clamped by the config ceiling", () => {
        expect(resolveFork(parentHistory).maxTurns).toBe(25);
        expect(resolveFork(parentHistory, 4).maxTurns).toBe(4);
    });

    test("the appended user message frames the fork and carries the task", () => {
        const { userPrompt } = resolveFork(parentHistory);
        expect(userPrompt).toContain("fork of the conversation above");
        expect(userPrompt).toContain("write the changelog entry");
    });

    test("its system prompt says only the final summary reaches the parent", () => {
        expect(resolveFork(parentHistory).systemPrompt).toContain("Fork subagent");
        expect(resolveFork(parentHistory).systemPrompt).toContain("stands on its own");
    });

    test("an empty parent history is not an error", () => {
        expect(resolveFork([]).seedHistory).toEqual([]);
    });
});
