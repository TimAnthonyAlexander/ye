import { describe, expect, it } from "bun:test";
import type { Config } from "../../config/index.ts";
import type { Message, Provider, ProviderEvent } from "../../providers/index.ts";
import type { SessionState } from "../state.ts";
import { newShapingFlags } from "../state.ts";
import { contextCollapse } from "./contextCollapse.ts";
import type { RequestBudget, ShaperContext } from "./types.ts";

interface StreamScript {
    readonly events: readonly ProviderEvent[];
    callCount: number;
}

const makeProvider = (script: StreamScript): Provider =>
    ({
        capabilities: { serverSideWebSearch: false },
        getContextSize: async () => 200_000,
        // eslint-disable-next-line require-yield
        stream: async function* () {
            script.callCount += 1;
            for (const evt of script.events) {
                yield evt;
            }
        },
    }) as unknown as Provider;

const summaryStream = (text: string): StreamScript => ({
    events: [
        { type: "text.delta", text },
        { type: "stop", reason: "end_turn" },
    ],
    callCount: 0,
});

const emptyStream = (): StreamScript => ({
    events: [{ type: "stop", reason: "end_turn" }],
    callCount: 0,
});

const makeState = (history: Message[], contextWindow = 1000): SessionState =>
    ({
        sessionId: "s",
        projectId: "p",
        projectRoot: "/tmp",
        mode: "AUTO",
        contextWindow,
        history,
        sessionRules: [],
        denialTrail: null,
        compactedThisTurn: false,
        shapingFlags: newShapingFlags(),
        selectedMemory: [],
        turnState: { readFiles: new Map(), todos: [] },
    }) as unknown as SessionState;

const makeBudget = (): RequestBudget => ({
    maxTokens: 2048,
    initialMaxTokens: 2048,
    tokensFreedThisTurn: 0,
});

const baseConfig = (): Config =>
    ({
        defaultModel: { provider: "openrouter", model: "test", allowFallbacks: false },
    }) as unknown as Config;

const makeCtx = (state: SessionState, provider: Provider, config: Config): ShaperContext => ({
    state,
    messages: state.history,
    provider,
    config,
    model: "test",
    budget: makeBudget(),
});

const userMsg = (n: number): Message => ({ role: "user", content: `u${n} ` + "x".repeat(50) });
const asstMsg = (n: number): Message => ({ role: "assistant", content: `a${n} ` + "y".repeat(50) });

const makeHistory = (count: number): Message[] =>
    Array.from({ length: count }, (_, i) => (i % 2 === 0 ? userMsg(i) : asstMsg(i)));

describe("contextCollapse", () => {
    it("skips when below threshold", async () => {
        const state = makeState(makeHistory(20), 1_000_000);
        const provider = makeProvider(summaryStream("ignored"));
        const result = await contextCollapse.run(makeCtx(state, provider, baseConfig()));
        expect(result).toBe("skip");
        expect(state.shapingFlags.contextCollapse).toBe(false);
    });

    it("skips when history is shorter than preserveRecent", async () => {
        const state = makeState(makeHistory(5), 100);
        const provider = makeProvider(summaryStream("ignored"));
        const result = await contextCollapse.run(makeCtx(state, provider, baseConfig()));
        expect(result).toBe("skip");
    });

    it("collapses older history into a single system summary message", async () => {
        const state = makeState(makeHistory(30), 500);
        const provider = makeProvider(summaryStream("brief summary text"));
        const ctx = makeCtx(state, provider, baseConfig());
        const result = await contextCollapse.run(ctx);
        expect(result).toBe("applied");
        expect(state.shapingFlags.contextCollapse).toBe(true);
        // Default preserveRecent = 12, so result is summary + 12 recent = 13.
        expect(state.history.length).toBe(13);
        expect(state.history[0]?.role).toBe("system");
        expect(state.history[0]?.content).toContain("brief summary text");
        expect(ctx.budget.tokensFreedThisTurn).toBeGreaterThan(0);
    });

    it("skips when summary is empty", async () => {
        const state = makeState(makeHistory(30), 500);
        const provider = makeProvider(emptyStream());
        const result = await contextCollapse.run(makeCtx(state, provider, baseConfig()));
        expect(result).toBe("skip");
        expect(state.shapingFlags.contextCollapse).toBe(false);
        expect(state.history.length).toBe(30);
    });

    it("is idempotent within a turn (one-shot flag)", async () => {
        const state = makeState(makeHistory(30), 500);
        const provider = makeProvider(summaryStream("first"));
        const ctx = makeCtx(state, provider, baseConfig());
        const first = await contextCollapse.run(ctx);
        expect(first).toBe("applied");
        const second = await contextCollapse.run(ctx);
        expect(second).toBe("skip");
    });

    it("boundary guard: shifts past tool result whose paired assistant is in older slice", async () => {
        // Build a history where the proposed boundary lands on a tool message.
        // total length = 30, preserveRecent default 12 → boundary at index 18.
        // Place the assistant-with-tool_calls at index 17 and tool result at 18.
        const history = makeHistory(30);
        history[17] = {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "c1", type: "function", function: { name: "Read", arguments: "{}" } },
            ],
        };
        history[18] = { role: "tool", tool_call_id: "c1", content: "result body" };
        const state = makeState(history, 500);
        const provider = makeProvider(summaryStream("guarded summary"));
        const result = await contextCollapse.run(makeCtx(state, provider, baseConfig()));
        expect(result).toBe("applied");
        // First message is the summary system message.
        expect(state.history[0]?.role).toBe("system");
        // Second message — the new boundary head — must NOT be a tool message
        // (the guard would have shifted past it).
        expect(state.history[1]?.role).not.toBe("tool");
    });

    it("respects custom collapsePreserveRecent config", async () => {
        const state = makeState(makeHistory(30), 500);
        const provider = makeProvider(summaryStream("config summary"));
        const config = {
            ...baseConfig(),
            compact: { threshold: 0.5, collapsePreserveRecent: 4 },
        } as unknown as Config;
        const result = await contextCollapse.run(makeCtx(state, provider, config));
        expect(result).toBe("applied");
        expect(state.history.length).toBe(5);
    });
});
