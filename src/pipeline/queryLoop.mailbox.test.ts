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
import { SubagentMailbox } from "../subagents/mailbox.ts";
import type { Event } from "./events.ts";
import { queryLoop } from "./index.ts";
import { newShapingFlags, newTurnState, type SessionState } from "./state.ts";

// One scripted response per turn; the last script repeats if the loop outlives
// the script, which only happens when a test is wrong about how far it runs.
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

const makeState = (projectRoot: string): SessionState => ({
    sessionId: "sub-session",
    projectId: "test-project",
    projectRoot,
    mode: "AUTO",
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
    // Marks this as a subagent run, which is what keeps the verify loop out of
    // these tests the same way it stays out of real subagents.
    parentSessionId: "parent-session",
    ghostWaitFiredThisPrompt: false,
});

const makeSession = (): SessionHandle => ({
    sessionId: "sub-session",
    path: "/tmp/sub-session.jsonl",
    appendEvent: async (_event: SessionEvent): Promise<void> => {},
    close: async (): Promise<void> => {},
});

const TEXT_TURN: readonly ProviderEvent[] = [
    { type: "text.delta", text: "done" },
    { type: "stop", reason: "end_turn" },
];

const globTurn = (id: string): readonly ProviderEvent[] => [
    { type: "tool_call", id, name: "Glob", args: { pattern: "*.ts" } },
    { type: "stop", reason: "tool_use" },
];

interface RunResult {
    readonly state: SessionState;
    readonly events: readonly Event[];
}

const run = async (
    projectRoot: string,
    provider: Provider,
    mailbox: SubagentMailbox,
    maxTurns: number,
    onEvent?: (evt: Event) => void,
): Promise<RunResult> => {
    const state = makeState(projectRoot);
    const events: Event[] = [];
    for await (const evt of queryLoop({
        provider,
        config: makeConfig(),
        state,
        session: makeSession(),
        userPrompt: "start working",
        signal: new AbortController().signal,
        maxTurnsOverride: maxTurns,
        mailbox,
    })) {
        events.push(evt);
        onEvent?.(evt);
    }
    return { state, events };
};

const userTexts = (state: SessionState): readonly string[] =>
    state.history
        .filter((m) => m.role === "user" && typeof m.content === "string")
        .map((m) => m.content as string);

let workDir: string;

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-mailbox-test-"));
    await writeFile(join(workDir, "sample.ts"), "const x = 1;\n", "utf8");
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("queryLoop steering mailbox", () => {
    test("a steer queued before the first turn is delivered with the prompt", async () => {
        const mailbox = new SubagentMailbox();
        mailbox.enqueue("prefer the smaller change");

        const { state } = await run(workDir, new ScriptedProvider([TEXT_TURN]), mailbox, 5);

        expect(userTexts(state)).toEqual(["start working", "prefer the smaller change"]);
        expect(mailbox.queued()).toHaveLength(0);
        expect(mailbox.messages()[0]!.status).toBe("delivered");
    });

    test("a steer that arrives mid-turn lands after the tool result, never between", async () => {
        const mailbox = new SubagentMailbox();
        const provider = new ScriptedProvider([globTurn("tc-1"), TEXT_TURN]);

        const { state } = await run(workDir, provider, mailbox, 5, (evt) => {
            if (evt.type === "tool.end") mailbox.enqueue("stop globbing");
        });

        const roles = state.history.map((m) => m.role);
        expect(roles).toEqual(["user", "assistant", "tool", "user", "assistant"]);
        expect(state.history[3]!.content).toBe("stop globbing");
    });

    test("a steer that arrives as the chain ends revives it for another turn", async () => {
        const mailbox = new SubagentMailbox();
        let sent = false;
        const { state, events } = await run(
            workDir,
            new ScriptedProvider([TEXT_TURN]),
            mailbox,
            5,
            (evt) => {
                if (evt.type === "turn.end" && !sent) {
                    sent = true;
                    mailbox.enqueue("one more thing");
                }
            },
        );

        expect(events.filter((e) => e.type === "turn.start")).toHaveLength(2);
        expect(userTexts(state)).toEqual(["start working", "one more thing"]);
    });

    test("a delivered steer is injected exactly once", async () => {
        const mailbox = new SubagentMailbox();
        let sent = false;
        const { state } = await run(
            workDir,
            new ScriptedProvider([TEXT_TURN]),
            mailbox,
            5,
            (evt) => {
                if (evt.type === "turn.end" && !sent) {
                    sent = true;
                    mailbox.enqueue("only once");
                }
            },
        );

        expect(userTexts(state).filter((t) => t === "only once")).toHaveLength(1);
    });

    test("a steer at the turn ceiling is rejected rather than silently extending it", async () => {
        const mailbox = new SubagentMailbox();
        const { state, events } = await run(
            workDir,
            new ScriptedProvider([TEXT_TURN]),
            mailbox,
            1,
            (evt) => {
                if (evt.type === "turn.end") mailbox.enqueue("squeeze this in");
            },
        );

        expect(events.filter((e) => e.type === "turn.start")).toHaveLength(1);
        expect(userTexts(state)).toEqual(["start working"]);
        expect(mailbox.queued()).toHaveLength(0);
        const rejected = mailbox.rejected();
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.text).toBe("squeeze this in");
        expect(rejected[0]!.rejection).toContain("ceiling of 1 turns");
    });

    test("a steer that fits under the ceiling is delivered", async () => {
        const mailbox = new SubagentMailbox();
        let sent = false;
        const { state, events } = await run(
            workDir,
            new ScriptedProvider([TEXT_TURN]),
            mailbox,
            2,
            (evt) => {
                if (evt.type === "turn.end" && !sent) {
                    sent = true;
                    mailbox.enqueue("just in time");
                }
            },
        );

        expect(events.filter((e) => e.type === "turn.start")).toHaveLength(2);
        expect(userTexts(state)).toEqual(["start working", "just in time"]);
        expect(mailbox.rejected()).toHaveLength(0);
    });

    test("an untouched mailbox leaves the loop exactly as it was", async () => {
        const mailbox = new SubagentMailbox();
        const { state, events } = await run(workDir, new ScriptedProvider([TEXT_TURN]), mailbox, 5);

        expect(events.filter((e) => e.type === "turn.start")).toHaveLength(1);
        expect(userTexts(state)).toEqual(["start working"]);
        expect(mailbox.messages()).toHaveLength(0);
    });
});
