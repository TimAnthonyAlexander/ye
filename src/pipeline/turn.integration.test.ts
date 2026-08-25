import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/index.ts";
import { PLAN_MODE_BLOCKED } from "../permissions/index.ts";
import type {
    Message,
    Provider,
    ProviderCapabilities,
    ProviderEvent,
    ProviderInput,
} from "../providers/index.ts";
import type { SessionHandle, SessionEvent } from "../storage/index.ts";
import {
    destroyMonitorManager,
    getMonitorManager,
    _resetMonitorTimings,
    _setMonitorTimings,
} from "../monitors/index.ts";
import type { Event, StopReason } from "./events.ts";
import { newShapingFlags, newTurnState, type SessionState } from "./state.ts";
import { PLAN_APPROVED_REMINDER } from "./stop.ts";
import { runTurn } from "./turn.ts";

// ---------------------------------------------------------------------------
// Mock Provider
// ---------------------------------------------------------------------------

class MockProvider implements Provider {
    readonly id = "mock";
    readonly capabilities: ProviderCapabilities = {
        promptCache: false,
        toolUse: true,
        vision: false,
        serverSideWebSearch: false,
    };

    constructor(private readonly events: ProviderEvent[]) {}

    async *stream(_input: ProviderInput): AsyncGenerator<ProviderEvent> {
        for (const event of this.events) {
            yield event;
        }
    }

    async countTokens(messages: readonly Message[]): Promise<number> {
        return Math.ceil(JSON.stringify(messages).length / 4);
    }

    async getContextSize(_model: string): Promise<number> {
        return 128_000;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeConfig = (overrides: Partial<Config> = {}): Config => ({
    defaultProvider: "mock",
    providers: { mock: { baseUrl: "https://example.test", apiKeyEnv: "MOCK_KEY" } },
    defaultModel: { provider: "mock", model: "mock-model" },
    compact: { threshold: 0.5, defaultMaxTokens: 16_384, minReplyTokens: 1024 },
    maxTurns: { master: 100, subagent: 25 },
    permissions: { defaultMode: "NORMAL", rules: [], heuristicGating: false },
    ...overrides,
});

const makeState = (projectRoot: string, overrides: Partial<SessionState> = {}): SessionState => ({
    sessionId: "test-session",
    projectId: "test-project",
    projectRoot,
    mode: "NORMAL",
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
    ghostWaitFiredThisPrompt: false,
    ghostWaitSuppressNext: false,
    ...overrides,
});

const makeSession = (): SessionHandle => ({
    sessionId: "test-session",
    path: "/tmp/test-session.jsonl",
    appendEvent: async (_event: SessionEvent): Promise<void> => {},
    close: async (): Promise<void> => {},
});

const collect = async (
    gen: AsyncGenerator<Event, StopReason>,
): Promise<{ events: Event[]; stopReason: StopReason }> => {
    const events: Event[] = [];
    while (true) {
        const result = await gen.next();
        if (result.done) return { events, stopReason: result.value };
        events.push(result.value);
    }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let workDir: string;

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-integration-test-"));
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("runTurn integration", () => {
    test("IT1 text-only turn: model responds with text, no tool calls", async () => {
        const provider = new MockProvider([
            { type: "text.delta", text: "Hello" },
            { type: "text.delta", text: " there!" },
            { type: "stop", reason: "end_turn" },
        ]);

        const config = makeConfig();
        const state = makeState(workDir, {
            history: [{ role: "user", content: "hello" }],
        });

        const gen = runTurn({
            provider,
            config,
            session: makeSession(),
            state,
            turnState: newTurnState(),
            turnIndex: 0,
            maxTurns: 100,
            signal: new AbortController().signal,
        });

        const { events, stopReason } = await collect(gen);

        // Verify turn.start
        const turnStart = events.find((e) => e.type === "turn.start");
        expect(turnStart).toBeDefined();
        if (turnStart?.type === "turn.start") {
            expect(turnStart.turnIndex).toBe(0);
        }

        // Verify model.text deltas
        const textEvents = events.filter((e) => e.type === "model.text");
        expect(textEvents.length).toBe(2);
        if (textEvents[0]?.type === "model.text") {
            expect(textEvents[0].delta).toBe("Hello");
        }
        if (textEvents[1]?.type === "model.text") {
            expect(textEvents[1].delta).toBe(" there!");
        }

        // Verify turn.end with stopReason "end_turn"
        const turnEnd = events.find((e) => e.type === "turn.end");
        expect(turnEnd).toBeDefined();
        if (turnEnd?.type === "turn.end") {
            expect(turnEnd.stopReason).toBe("end_turn");
        }

        // Generator return value matches
        expect(stopReason).toBe("end_turn");

        // State history has assistant message with the text
        const assistantMsg = state.history.find((m) => m.role === "assistant");
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg!.content).toBe("Hello there!");
    });

    test("IT2 read-only tool call: Glob executes and history records the result", async () => {
        // Seed the temp dir with a .ts file so Glob has something to match.
        await writeFile(join(workDir, "sample.ts"), "const x = 1;\n", "utf8");

        const provider = new MockProvider([
            {
                type: "tool_call",
                id: "tc-glob-1",
                name: "Glob",
                args: { pattern: "*.ts" },
            },
            { type: "stop", reason: "tool_use" },
        ]);

        const config = makeConfig();
        const state = makeState(workDir, {
            history: [{ role: "user", content: "find all typescript files" }],
        });

        const gen = runTurn({
            provider,
            config,
            session: makeSession(),
            state,
            turnState: newTurnState(),
            turnIndex: 0,
            maxTurns: 100,
            signal: new AbortController().signal,
        });

        const { events, stopReason } = await collect(gen);

        // Verify tool.start
        const toolStart = events.find((e) => e.type === "tool.start" && e.name === "Glob");
        expect(toolStart).toBeDefined();
        if (toolStart?.type === "tool.start") {
            expect(toolStart.id).toBe("tc-glob-1");
            expect(toolStart.name).toBe("Glob");
        }

        // Verify tool.end with ok result
        const toolEnd = events.find((e) => e.type === "tool.end" && e.name === "Glob");
        expect(toolEnd).toBeDefined();
        if (toolEnd?.type === "tool.end") {
            expect(toolEnd.id).toBe("tc-glob-1");
            expect(toolEnd.result.ok).toBe(true);
            if (toolEnd.result.ok) {
                const value = toolEnd.result.value as { paths: string[]; truncated: boolean };
                expect(value.paths.length).toBeGreaterThanOrEqual(1);
                expect(value.paths.some((p: string) => p.endsWith("sample.ts"))).toBe(true);
            }
        }

        // State history: assistant with tool_calls AND tool result
        const assistantMsg = state.history.find((m) => m.role === "assistant");
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg!.tool_calls).toBeDefined();
        if (assistantMsg!.tool_calls) {
            expect(assistantMsg!.tool_calls.length).toBe(1);
            expect(assistantMsg!.tool_calls[0]!.function.name).toBe("Glob");
        }

        const toolMsg = state.history.find((m) => m.role === "tool");
        expect(toolMsg).toBeDefined();
        expect(toolMsg!.tool_call_id).toBe("tc-glob-1");
        // Content should mention sample.ts since Glob found it
        expect(typeof toolMsg!.content).toBe("string");
        expect(toolMsg!.content as string).toContain("sample.ts");

        // The turn had tool calls so evaluateStop returns null → "continue"
        expect(stopReason).toBe("continue");
    });

    test("IT3 plan mode denial: Edit is blocked with PLAN_MODE_BLOCKED", async () => {
        const provider = new MockProvider([
            {
                type: "tool_call",
                id: "tc-edit-1",
                name: "Edit",
                args: { path: "foo.txt", old_string: "a", new_string: "b" },
            },
            { type: "stop", reason: "tool_use" },
        ]);

        const config = makeConfig();
        const state = makeState(workDir, {
            mode: "PLAN",
            history: [{ role: "user", content: "edit foo.txt" }],
        });

        const gen = runTurn({
            provider,
            config,
            session: makeSession(),
            state,
            turnState: newTurnState(),
            turnIndex: 0,
            maxTurns: 100,
            signal: new AbortController().signal,
        });

        const { events, stopReason } = await collect(gen);

        // Verify tool.start for Edit
        const toolStart = events.find((e) => e.type === "tool.start" && e.name === "Edit");
        expect(toolStart).toBeDefined();
        if (toolStart?.type === "tool.start") {
            expect(toolStart.id).toBe("tc-edit-1");
        }

        // Verify tool.end with denied result
        const toolEnd = events.find((e) => e.type === "tool.end" && e.name === "Edit");
        expect(toolEnd).toBeDefined();
        if (toolEnd?.type === "tool.end") {
            expect(toolEnd.id).toBe("tc-edit-1");
            expect(toolEnd.result.ok).toBe(false);
            if (!toolEnd.result.ok) {
                expect(toolEnd.result.error).toBe(PLAN_MODE_BLOCKED);
            }
        }

        // State history contains tool result with PLAN_MODE_BLOCKED
        const toolMsg = state.history.find((m) => m.role === "tool");
        expect(toolMsg).toBeDefined();
        expect(toolMsg!.tool_call_id).toBe("tc-edit-1");
        expect(toolMsg!.content).toContain(PLAN_MODE_BLOCKED);

        // No actual Edit execution happened; stopReason is "continue" (tool calls
        // were present so evaluateStop returns null → "continue").
        expect(stopReason).toBe("continue");
    });

    // The ExitPlanMode tool result records that a prompt was *requested*, never
    // the user's answer. Without the reminder the model reads that back and
    // asks "shall I start?" after the user already accepted.
    test("IT4 plan just accepted: the go-ahead reaches the model before it replies", async () => {
        const provider = new MockProvider([
            { type: "text.delta", text: "starting" },
            { type: "stop", reason: "end_turn" },
        ]);

        let seen: readonly Message[] = [];
        const recordingProvider: Provider = {
            id: provider.id,
            capabilities: provider.capabilities,
            async *stream(input: ProviderInput) {
                seen = input.messages;
                yield* provider.stream(input);
            },
            getContextSize: (model: string) => provider.getContextSize(model),
        };

        const state = makeState(workDir, {
            history: [
                { role: "user", content: "write the plan" },
                { role: "tool", tool_call_id: "ep1", content: '{"kind":"request_mode_flip"}' },
            ],
            planJustAccepted: true,
        });

        await collect(
            runTurn({
                provider: recordingProvider,
                config: makeConfig(),
                session: makeSession(),
                state,
                turnState: newTurnState(),
                turnIndex: 0,
                maxTurns: 100,
                signal: new AbortController().signal,
            }),
        );

        const reminder = seen.find(
            (m) => m.role === "user" && m.content === PLAN_APPROVED_REMINDER,
        );
        expect(reminder).toBeDefined();
        // It has to follow the tool result, or the model reads the go-ahead
        // before the call it answers.
        const reminderIdx = seen.findIndex((m) => m.content === PLAN_APPROVED_REMINDER);
        const toolIdx = seen.findIndex((m) => m.role === "tool");
        expect(reminderIdx).toBeGreaterThan(toolIdx);
        // One acceptance, one reminder.
        expect(state.planJustAccepted).toBe(false);
    });

    test("IT5 no acceptance pending: no go-ahead is injected", async () => {
        const provider = new MockProvider([
            { type: "text.delta", text: "hi" },
            { type: "stop", reason: "end_turn" },
        ]);

        const state = makeState(workDir, { history: [{ role: "user", content: "hello" }] });

        await collect(
            runTurn({
                provider,
                config: makeConfig(),
                session: makeSession(),
                state,
                turnState: newTurnState(),
                turnIndex: 0,
                maxTurns: 100,
                signal: new AbortController().signal,
            }),
        );

        expect(state.history.some((m) => m.content === PLAN_APPROVED_REMINDER)).toBe(false);
    });
});

describe("monitor drain", () => {
    const monitorSession = "monitor-drain-session";

    beforeEach(() => {
        _setMonitorTimings({ intervalFloorMs: 20, pollTimeoutMs: 5_000 });
    });

    afterEach(() => {
        destroyMonitorManager(monitorSession);
        _resetMonitorTimings();
    });

    const runOneTurn = async (state: SessionState): Promise<void> => {
        await collect(
            runTurn({
                provider: new MockProvider([
                    { type: "text.delta", text: "ok" },
                    { type: "stop", reason: "end_turn" },
                ]),
                config: makeConfig(),
                session: makeSession(),
                state,
                turnState: newTurnState(),
                turnIndex: 0,
                maxTurns: 100,
                signal: new AbortController().signal,
            }),
        );
    };

    test("a finished monitor reaches history exactly once as a system-reminder", async () => {
        const mgr = getMonitorManager(monitorSession);
        const id = mgr.start({ reason: "wait for the build", condition: "true" }, workDir);
        for (let i = 0; i < 400 && !mgr.hasUndelivered(); i += 1) {
            await new Promise((r) => setTimeout(r, 10));
        }

        const state = makeState(workDir, {
            sessionId: monitorSession,
            history: [{ role: "user", content: "hello" }],
        });

        await runOneTurn(state);
        const notices = state.history.filter(
            (m) => typeof m.content === "string" && m.content.includes(id),
        );
        expect(notices).toHaveLength(1);
        expect(notices[0]!.role).toBe("user");
        expect(notices[0]!.content).toContain("<system-reminder>");
        expect(notices[0]!.content).toContain("OUTCOME condition_met");

        await runOneTurn(state);
        expect(
            state.history.filter((m) => typeof m.content === "string" && m.content.includes(id)),
        ).toHaveLength(1);
    });

    // gave_up must read as "never observed true", never as a verdict on the job.
    test("a gave_up monitor is drained with its outcome intact", async () => {
        const mgr = getMonitorManager(monitorSession);
        const id = mgr.start(
            { reason: "wait for the build", condition: "false", giveUpAfterSec: 0 },
            workDir,
        );
        for (let i = 0; i < 400 && !mgr.hasUndelivered(); i += 1) {
            await new Promise((r) => setTimeout(r, 10));
        }

        const state = makeState(workDir, {
            sessionId: monitorSession,
            history: [{ role: "user", content: "hello" }],
        });
        await runOneTurn(state);

        const notice = state.history.find(
            (m) => typeof m.content === "string" && m.content.includes(id),
        );
        expect(notice).toBeDefined();
        expect(notice!.content).toContain("OUTCOME gave_up");
        expect(notice!.content).toContain("the condition was NEVER true at any poll");
        expect(notice!.content).toContain("Check it directly");
    });
});
