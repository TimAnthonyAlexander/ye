import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/index.ts";
import type {
    Message,
    Provider,
    ProviderCapabilities,
    ProviderEvent,
    ProviderInput,
} from "../providers/index.ts";
import type { SessionEvent, SessionHandle } from "../storage/index.ts";
import type { Event } from "./events.ts";
import { GHOST_WAIT_REMINDER } from "./ghostWait.ts";
import { queryLoop } from "./index.ts";
import { newShapingFlags, newTurnState, type SessionState } from "./state.ts";

class ScriptedProvider implements Provider {
    readonly id = "mock";
    readonly capabilities: ProviderCapabilities = {
        promptCache: false,
        toolUse: true,
        vision: false,
        serverSideWebSearch: false,
    };
    private turn = 0;

    constructor(private readonly script: readonly (readonly ProviderEvent[])[]) {}

    async *stream(_input: ProviderInput): AsyncGenerator<ProviderEvent> {
        const events = this.script[Math.min(this.turn, this.script.length - 1)]!;
        this.turn += 1;
        for (const event of events) yield event;
    }

    async countTokens(messages: readonly Message[]): Promise<number> {
        return Math.ceil(JSON.stringify(messages).length / 4);
    }

    async getContextSize(_model: string): Promise<number> {
        return 128_000;
    }
}

const makeConfig = (): Config => ({
    defaultProvider: "mock",
    providers: { mock: { baseUrl: "https://example.test", apiKeyEnv: "MOCK_KEY" } },
    defaultModel: { provider: "mock", model: "mock-model" },
    compact: { threshold: 0.5, defaultMaxTokens: 16_384, minReplyTokens: 1024 },
    maxTurns: { master: 100, subagent: 25 },
    permissions: { defaultMode: "NORMAL", rules: [], heuristicGating: false },
});

const makeState = (projectRoot: string, mode: SessionState["mode"] = "AUTO"): SessionState => ({
    sessionId: "ghost-wait-loop-session",
    projectId: "test-project",
    projectRoot,
    mode,
    contextWindow: 128_000,
    history: [],
    sessionRules: [],
    denialTrail: null,
    compactedThisTurn: false,
    shapingFlags: newShapingFlags(),
    globalTurnIndex: 0,
    selectedMemory: [],
    turnState: newTurnState(),
    headless: false,
    // Keeps the verify loop out, exactly as it stays out of real subagent runs.
    parentSessionId: "parent-session",
    ghostWaitFiredThisPrompt: false,
    ghostWaitSuppressNext: false,
});

const makeSession = (): SessionHandle => ({
    sessionId: "ghost-wait-loop-session",
    path: "/tmp/ghost-wait-loop-session.jsonl",
    appendEvent: async (_event: SessionEvent): Promise<void> => {},
    close: async (): Promise<void> => {},
});

// Trips detectGhostWait: says it is waiting, starts nothing.
const GHOST_TURN: readonly ProviderEvent[] = [
    { type: "text.delta", text: "Waiting for the build to finish." },
    { type: "stop", reason: "end_turn" },
];

const TEXT_TURN = (text: string): readonly ProviderEvent[] => [
    { type: "text.delta", text },
    { type: "stop", reason: "end_turn" },
];

const WRITE_TURN = (path: string): readonly ProviderEvent[] => [
    { type: "tool_call", id: "tc-w", name: "Write", args: { file_path: path, content: "hi\n" } },
    { type: "stop", reason: "tool_use" },
];

const TEXT_THEN_GLOB: readonly ProviderEvent[] = [
    { type: "text.delta", text: "Checking the tree first." },
    { type: "tool_call", id: "tc-1", name: "Glob", args: { pattern: "*.ts" } },
    { type: "stop", reason: "tool_use" },
];

const run = async (
    projectRoot: string,
    provider: Provider,
    opts: { readonly mode?: SessionState["mode"]; readonly onEvent?: (evt: Event) => void } = {},
): Promise<{ state: SessionState; events: readonly Event[] }> => {
    const state = makeState(projectRoot, opts.mode);
    const events: Event[] = [];
    for await (const evt of queryLoop({
        provider,
        config: makeConfig(),
        state,
        session: makeSession(),
        userPrompt: "start working",
        signal: new AbortController().signal,
        maxTurnsOverride: 6,
    })) {
        events.push(evt);
        opts.onEvent?.(evt);
    }
    return { state, events };
};

const streamedText = (events: readonly Event[]): string =>
    events
        .filter((e) => e.type === "model.text")
        .map((e) => (e as { readonly delta: string }).delta)
        .join("");

let workDir: string;

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-ghost-wait-loop-"));
    await writeFile(join(workDir, "sample.ts"), "const x = 1;\n", "utf8");
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("queryLoop ghost-wait suppression", () => {
    test("a text-only reply to the nudge is hidden and leaves no trace in history", async () => {
        const { state, events } = await run(
            workDir,
            new ScriptedProvider([GHOST_TURN, TEXT_TURN("done")]),
        );

        expect(streamedText(events)).toBe("Waiting for the build to finish.");
        expect(events.filter((e) => e.type === "turn.start")).toHaveLength(1);
        expect(state.history.map((m) => m.role)).toEqual(["user", "assistant"]);
        expect(state.history.some((m) => m.content === GHOST_WAIT_REMINDER)).toBe(false);
    });

    test("a tool call in the reply flushes the text before it, the call, and the rest", async () => {
        const { state, events } = await run(
            workDir,
            new ScriptedProvider([GHOST_TURN, TEXT_THEN_GLOB, TEXT_TURN("all clear")]),
        );

        expect(streamedText(events)).toBe(
            "Waiting for the build to finish.Checking the tree first.all clear",
        );
        expect(events.filter((e) => e.type === "turn.start")).toHaveLength(3);
        expect(events.filter((e) => e.type === "tool.end")).toHaveLength(1);
        // The nudge stays in history once its reply was real work.
        expect(state.history.some((m) => m.content === GHOST_WAIT_REMINDER)).toBe(true);
    });

    // The flush has to happen the moment the tool call appears, not at turn end:
    // permission.prompt carries the callback the turn is blocked on, so holding
    // it in the buffer deadlocks the run outright rather than merely delaying it.
    test("a tool call needing permission still reaches the consumer", async () => {
        const { events } = await run(
            workDir,
            new ScriptedProvider([
                GHOST_TURN,
                WRITE_TURN(join(workDir, "out.txt")),
                TEXT_TURN("written"),
            ]),
            {
                mode: "NORMAL",
                onEvent: (evt) => {
                    if (evt.type === "permission.prompt") evt.respond("allow_once");
                },
            },
        );

        expect(events.filter((e) => e.type === "permission.prompt")).toHaveLength(1);
        expect(streamedText(events)).toContain("written");
    }, 5_000);

    test("the nudge fires at most once per prompt", async () => {
        const { state } = await run(
            workDir,
            new ScriptedProvider([GHOST_TURN, GHOST_TURN, GHOST_TURN]),
        );

        expect(state.history.filter((m) => m.content === GHOST_WAIT_REMINDER)).toHaveLength(0);
        expect(state.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    });
});
