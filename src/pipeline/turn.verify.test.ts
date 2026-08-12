import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, VerifyConfig } from "../config/types.ts";
import type {
    Message,
    Provider,
    ProviderCapabilities,
    ProviderEvent,
    ProviderInput,
} from "../providers/index.ts";
import { _wipeSessionCheckpoints } from "../storage/checkpoints.ts";
import type { SessionEvent, SessionHandle } from "../storage/index.ts";
import type { Event, StopReason } from "./events.ts";
import { newShapingFlags, newTurnState, type SessionState } from "./state.ts";
import { runTurn } from "./turn.ts";
import { clearVerifyChain, recordToolWrite } from "./verify.ts";

class MockProvider implements Provider {
    readonly id = "mock";
    readonly capabilities: ProviderCapabilities = {
        promptCache: false,
        toolUse: true,
        vision: false,
        serverSideWebSearch: false,
    };
    calls = 0;

    constructor(private readonly events: readonly ProviderEvent[]) {}

    async *stream(_input: ProviderInput): AsyncGenerator<ProviderEvent> {
        this.calls += 1;
        for (const event of this.events) yield event;
    }

    async countTokens(messages: readonly Message[]): Promise<number> {
        return Math.ceil(JSON.stringify(messages).length / 4);
    }

    async getContextSize(_model: string): Promise<number> {
        return 128_000;
    }
}

const textOnlyProvider = (): MockProvider =>
    new MockProvider([
        { type: "text.delta", text: "done" },
        { type: "stop", reason: "end_turn" },
    ]);

const PROJECT_ID = "verify-turn-project";

const makeConfig = (overrides: Partial<Config> = {}): Config => ({
    defaultProvider: "mock",
    providers: { mock: { baseUrl: "https://example.test", apiKeyEnv: "MOCK_KEY" } },
    defaultModel: { provider: "mock", model: "mock-model" },
    compact: { threshold: 0.5, defaultMaxTokens: 16_384, minReplyTokens: 1024 },
    maxTurns: { master: 100, subagent: 25 },
    permissions: { defaultMode: "AUTO", rules: [], heuristicGating: false },
    ...overrides,
});

const makeState = (
    projectRoot: string,
    sessionId: string,
    overrides: Partial<SessionState> = {},
): SessionState => ({
    sessionId,
    projectId: PROJECT_ID,
    projectRoot,
    mode: "AUTO",
    contextWindow: 128_000,
    history: [{ role: "user", content: "do the thing" }],
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
    sessionId: "verify-turn-session",
    path: "/tmp/verify-turn-session.jsonl",
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

const lastContent = (state: SessionState): string => {
    const last = state.history[state.history.length - 1];
    return typeof last?.content === "string" ? last.content : "";
};

let workDir: string;
let sessionId: string;
let counter = 0;

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-turn-verify-test-"));
    counter += 1;
    sessionId = `verify-turn-session-${counter}`;
});

afterEach(async () => {
    clearVerifyChain(sessionId);
    await _wipeSessionCheckpoints(PROJECT_ID, sessionId);
    await rm(workDir, { recursive: true, force: true });
});

const runOnce = async (
    provider: MockProvider,
    config: Config,
    state: SessionState,
): Promise<{ events: Event[]; stopReason: StopReason }> =>
    collect(
        runTurn({
            provider,
            config,
            session: makeSession(),
            state,
            turnState: state.turnState,
            turnIndex: 0,
            maxTurns: 100,
            signal: new AbortController().signal,
        }),
    );

describe("post-edit verification in runTurn", () => {
    const verify = (extra: Partial<VerifyConfig> = {}): VerifyConfig => ({
        enabled: true,
        test: "touch verify-ran",
        ...extra,
    });

    test("TV1 nothing was written this chain → verification never runs", async () => {
        const state = makeState(workDir, sessionId);
        const { stopReason } = await runOnce(
            textOnlyProvider(),
            makeConfig({ verify: verify() }),
            state,
        );
        expect(stopReason).toBe("end_turn");
        expect(existsSync(join(workDir, "verify-ran"))).toBe(false);
    });

    test("TV2 verify.enabled false → verification never runs", async () => {
        recordToolWrite(sessionId, "Write", true);
        const state = makeState(workDir, sessionId);
        const { stopReason } = await runOnce(
            textOnlyProvider(),
            makeConfig({ verify: verify({ enabled: false }) }),
            state,
        );
        expect(stopReason).toBe("end_turn");
        expect(existsSync(join(workDir, "verify-ran"))).toBe(false);
    });

    test("TV3 no configured command → verification never runs", async () => {
        recordToolWrite(sessionId, "Edit", true);
        const state = makeState(workDir, sessionId);
        const { stopReason } = await runOnce(
            textOnlyProvider(),
            makeConfig({ verify: { enabled: true } }),
            state,
        );
        expect(stopReason).toBe("end_turn");
    });

    test("TV3b subagent chain never verifies even with writes and a failing command", async () => {
        recordToolWrite(sessionId, "Write", true);
        const state = makeState(workDir, sessionId, { parentSessionId: "parent-session" });
        const { stopReason } = await runOnce(
            textOnlyProvider(),
            makeConfig({ verify: verify({ test: "touch verify-ran && exit 1" }) }),
            state,
        );
        expect(stopReason).toBe("end_turn");
        expect(existsSync(join(workDir, "verify-ran"))).toBe(false);
    });

    test("TV4 success injects nothing and lets the turn end", async () => {
        recordToolWrite(sessionId, "Write", true);
        const state = makeState(workDir, sessionId);
        const { stopReason } = await runOnce(
            textOnlyProvider(),
            makeConfig({ verify: verify({ test: "exit 0" }) }),
            state,
        );
        expect(stopReason).toBe("end_turn");
        expect(state.history[state.history.length - 1]?.role).toBe("assistant");
        expect(state.history.some((m) => String(m.content ?? "").includes("verification"))).toBe(
            false,
        );
    });

    test("TV5 failure injects the failing command plus output and continues", async () => {
        recordToolWrite(sessionId, "Write", true);
        const state = makeState(workDir, sessionId);
        const { stopReason } = await runOnce(
            textOnlyProvider(),
            makeConfig({ verify: verify({ test: "echo assertion-blew-up; exit 1" }) }),
            state,
        );
        expect(stopReason).toBe("continue");
        const injected = lastContent(state);
        expect(injected).toContain("<system-reminder>");
        expect(injected).toContain("Post-edit verification");
        expect(injected).toContain("echo assertion-blew-up; exit 1");
        expect(injected).toContain("assertion-blew-up");
    });

    test("TV6 typecheck failure short-circuits: lint and test never run", async () => {
        recordToolWrite(sessionId, "Write", true);
        const state = makeState(workDir, sessionId);
        await runOnce(
            textOnlyProvider(),
            makeConfig({
                verify: {
                    enabled: true,
                    typecheck: "exit 1",
                    lint: "touch lint-ran",
                    test: "touch test-ran",
                },
            }),
            state,
        );
        expect(existsSync(join(workDir, "lint-ran"))).toBe(false);
        expect(existsSync(join(workDir, "test-ran"))).toBe(false);
    });

    test("TV7 a timeout is reported as a timeout, not as a failing test", async () => {
        recordToolWrite(sessionId, "Write", true);
        const state = makeState(workDir, sessionId);
        const { stopReason } = await runOnce(
            textOnlyProvider(),
            makeConfig({ verify: { enabled: true, test: "sleep 5", timeoutMs: 250 } }),
            state,
        );
        expect(stopReason).toBe("continue");
        expect(lastContent(state)).toContain("TIMED OUT");
    });

    test("TV8 at most two verify-triggered continuations per chain", async () => {
        recordToolWrite(sessionId, "Write", true);
        const state = makeState(workDir, sessionId);
        const config = makeConfig({ verify: verify({ test: "exit 1" }) });

        const first = await runOnce(textOnlyProvider(), config, state);
        expect(first.stopReason).toBe("continue");
        const second = await runOnce(textOnlyProvider(), config, state);
        expect(second.stopReason).toBe("continue");
        const third = await runOnce(textOnlyProvider(), config, state);
        expect(third.stopReason).toBe("end_turn");
        expect(lastContent(state)).toContain("will not be retried");
    });

    test("TV9 a successful Write during the turn arms verification for that chain", async () => {
        const path = join(workDir, "new-file.txt");
        const provider = new MockProvider([
            {
                type: "tool_call",
                id: "tc-write-1",
                name: "Write",
                args: { path, content: "hello\n" },
            },
            { type: "stop", reason: "tool_use" },
        ]);
        const state = makeState(workDir, sessionId);
        const config = makeConfig({ verify: verify({ test: "exit 1" }) });

        const writeTurn = await runOnce(provider, config, state);
        expect(writeTurn.stopReason).toBe("continue");
        expect(existsSync(path)).toBe(true);

        const stopTurn = await runOnce(textOnlyProvider(), config, state);
        expect(stopTurn.stopReason).toBe("continue");
        expect(lastContent(state)).toContain("Post-edit verification");
    });
});

describe("budget cap in runTurn", () => {
    test("TB1 spend at or over the cap stops before the model is called", async () => {
        const provider = textOnlyProvider();
        const state = makeState(workDir, sessionId);
        const { events, stopReason } = await collect(
            runTurn({
                provider,
                config: makeConfig({ budget: { maxUsd: 0.5 } }),
                session: makeSession(),
                state,
                turnState: state.turnState,
                turnIndex: 0,
                maxTurns: 100,
                signal: new AbortController().signal,
                loadSpentUsd: async () => 0.75,
            }),
        );
        expect(stopReason).toBe("budget_exhausted");
        expect(provider.calls).toBe(0);
        const end = events.find((e) => e.type === "turn.end");
        expect(end?.type === "turn.end" && end.message).toContain("$0.7500");
        expect(end?.type === "turn.end" && end.message).toContain("$0.50");
    });

    test("TB2 spend under the cap dispatches normally", async () => {
        const provider = textOnlyProvider();
        const state = makeState(workDir, sessionId);
        const { stopReason } = await collect(
            runTurn({
                provider,
                config: makeConfig({ budget: { maxUsd: 5 } }),
                session: makeSession(),
                state,
                turnState: state.turnState,
                turnIndex: 0,
                maxTurns: 100,
                signal: new AbortController().signal,
                loadSpentUsd: async () => 0.25,
            }),
        );
        expect(stopReason).toBe("end_turn");
        expect(provider.calls).toBe(1);
    });

    test("TB3 no cap configured → spend is never loaded", async () => {
        const provider = textOnlyProvider();
        const state = makeState(workDir, sessionId);
        let loaded = false;
        const { stopReason } = await collect(
            runTurn({
                provider,
                config: makeConfig(),
                session: makeSession(),
                state,
                turnState: state.turnState,
                turnIndex: 0,
                maxTurns: 100,
                signal: new AbortController().signal,
                loadSpentUsd: async () => {
                    loaded = true;
                    return 999;
                },
            }),
        );
        expect(stopReason).toBe("end_turn");
        expect(loaded).toBe(false);
        expect(provider.calls).toBe(1);
    });
});
