import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/index.ts";
import { restoredSessionRules, SESSION_RULE_EVENT } from "../permissions/index.ts";
import { replaySessionFile } from "./replay.ts";
import { recordSessionRule, type SessionHandle } from "./session.ts";

let workDir: string;

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-session-rules-"));
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

// Mirrors the append format of the real handles without writing under ~/.ye.
const stubSession = (path: string): SessionHandle => ({
    sessionId: "stub",
    path,
    async appendEvent(event) {
        await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
    },
    async close() {},
});

const writeJsonl = async (events: ReadonlyArray<Record<string, unknown>>): Promise<string> => {
    const path = join(workDir, "session.jsonl");
    await writeFile(path, events.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
    return path;
};

const configWith = (persistSessionRules?: boolean): Config =>
    ({
        permissions: {
            defaultMode: "NORMAL",
            rules: [],
            ...(persistSessionRules !== undefined ? { persistSessionRules } : {}),
        },
    }) as unknown as Config;

describe("session rules round-trip", () => {
    test("a recorded grant comes back on replay", async () => {
        const path = join(workDir, "session.jsonl");
        const session = stubSession(path);
        await session.appendEvent({ type: "user.message", content: "hi" });
        await recordSessionRule(session, { effect: "allow", tool: "Bash" });

        const out = await replaySessionFile(path);
        expect(out.sessionRules).toEqual([{ effect: "allow", tool: "Bash" }]);
    });

    test("a patterned grant round-trips its pattern", async () => {
        const path = join(workDir, "session.jsonl");
        await recordSessionRule(stubSession(path), {
            effect: "allow",
            tool: "Bash",
            pattern: "Bash(npm *)",
        });
        const out = await replaySessionFile(path);
        expect(out.sessionRules[0]).toEqual({
            effect: "allow",
            tool: "Bash",
            pattern: "Bash(npm *)",
        });
    });

    test("the grant is not a message and never reaches history", async () => {
        const path = join(workDir, "session.jsonl");
        const session = stubSession(path);
        await session.appendEvent({ type: "user.message", content: "hi" });
        await recordSessionRule(session, { effect: "allow", tool: "Edit" });
        await session.appendEvent({ type: "turn.start", turnIndex: 0 });
        await session.appendEvent({ type: "model.text", delta: "done" });
        await session.appendEvent({ type: "turn.end", stopReason: "end_turn" });

        const out = await replaySessionFile(path);
        expect(out.history).toEqual([
            { role: "user", content: "hi" },
            { role: "assistant", content: "done" },
        ]);
        expect(JSON.stringify(out.history)).not.toContain("Edit");
    });

    test("a malformed grant event is ignored", async () => {
        const path = await writeJsonl([
            { type: "user.message", content: "hi" },
            { type: SESSION_RULE_EVENT, effect: "allow" },
        ]);
        const out = await replaySessionFile(path);
        expect(out.sessionRules).toEqual([]);
    });

    test("a cleared session (fresh transcript) restores nothing", async () => {
        const out = await replaySessionFile(await writeJsonl([]));
        expect(out.sessionRules).toEqual([]);
    });
});

describe("session rules and /rewind", () => {
    const transcript = [
        { type: "user.message", content: "first" },
        {
            type: "prompt.start",
            firstTurnGlobalIdx: 1,
            preview: "first",
            ts: "2025-01-01T00:00:00Z",
        },
        { type: SESSION_RULE_EVENT, effect: "allow", tool: "Bash" },
        { type: "turn.start", turnIndex: 0 },
        { type: "model.text", delta: "one" },
        { type: "turn.end", stopReason: "end_turn" },
        { type: "user.message", content: "second" },
        {
            type: "prompt.start",
            firstTurnGlobalIdx: 2,
            preview: "second",
            ts: "2025-01-01T00:00:01Z",
        },
        { type: SESSION_RULE_EVENT, effect: "allow", tool: "Write" },
        { type: "turn.start", turnIndex: 1 },
        { type: "model.text", delta: "two" },
        { type: "turn.end", stopReason: "end_turn" },
    ];

    test("grants made under a rewound prompt are dropped, earlier ones survive", async () => {
        const path = await writeJsonl([
            ...transcript,
            { type: "rewind", upToPrompt: 1, firstTurnGlobalIdx: 2 },
        ]);
        const out = await replaySessionFile(path);
        expect(out.sessionRules).toEqual([{ effect: "allow", tool: "Bash" }]);
    });

    test("rewinding to the first prompt drops every grant", async () => {
        const path = await writeJsonl([
            ...transcript,
            { type: "rewind", upToPrompt: 0, firstTurnGlobalIdx: 1 },
        ]);
        const out = await replaySessionFile(path);
        expect(out.sessionRules).toEqual([]);
    });

    test("without a rewind both grants survive", async () => {
        const out = await replaySessionFile(await writeJsonl(transcript));
        expect(out.sessionRules).toEqual([
            { effect: "allow", tool: "Bash" },
            { effect: "allow", tool: "Write" },
        ]);
    });
});

describe("restoredSessionRules", () => {
    const replayed = [{ effect: "allow" as const, tool: "Bash" }];

    test("restores when the key is absent", () => {
        expect(restoredSessionRules(configWith(), replayed)).toEqual(replayed);
    });

    test("restores when the key is true", () => {
        expect(restoredSessionRules(configWith(true), replayed)).toEqual(replayed);
    });

    test("restores nothing when the key is false", () => {
        expect(restoredSessionRules(configWith(false), replayed)).toEqual([]);
    });

    test("returns a fresh array, not the replayed one", () => {
        const out = restoredSessionRules(configWith(), replayed);
        out.push({ effect: "allow", tool: "Write" });
        expect(replayed).toHaveLength(1);
    });
});
