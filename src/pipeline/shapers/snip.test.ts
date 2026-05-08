import { describe, expect, it } from "bun:test";
import type { Config } from "../../config/index.ts";
import type { Message, Provider } from "../../providers/index.ts";
import type { SessionState } from "../state.ts";
import { newShapingFlags } from "../state.ts";
import { SNIP_STUB, snip } from "./snip.ts";
import type { RequestBudget, ShaperContext } from "./types.ts";

const stubProvider: Provider = {
    capabilities: { serverSideWebSearch: false },
    getContextSize: async () => 200_000,
    stream: async function* () {},
} as unknown as Provider;

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

const makeCtx = (state: SessionState, config: Config = {} as unknown as Config): ShaperContext => ({
    state,
    messages: state.history,
    provider: stubProvider,
    config,
    model: "test",
    budget: makeBudget(),
});

const big = (toolCallId: string, sizeChars = 4000): Message => ({
    role: "tool",
    tool_call_id: toolCallId,
    content: "x".repeat(sizeChars),
});

const userMsg = (content = "hi"): Message => ({ role: "user", content });
const asstMsg = (content = "hello"): Message => ({ role: "assistant", content });

describe("snip", () => {
    it("skips when below threshold", async () => {
        const state = makeState([userMsg(), big("a"), asstMsg()], 200_000);
        const before = JSON.stringify(state.history);
        const result = await snip.run(makeCtx(state));
        expect(result).toBe("skip");
        expect(JSON.stringify(state.history)).toBe(before);
        expect(state.shapingFlags.snip).toBe(false);
    });

    it("skips when no tool messages outside protected tail", async () => {
        const history = [userMsg(), asstMsg(), userMsg(), asstMsg()];
        const state = makeState(history, 100);
        const result = await snip.run(makeCtx(state));
        expect(result).toBe("skip");
    });

    it("snips the biggest old tool result", async () => {
        const history: Message[] = [
            userMsg(),
            asstMsg(),
            big("call_1", 4000),
            asstMsg(),
            userMsg(),
            asstMsg(),
            userMsg(),
            asstMsg(),
            userMsg(),
            asstMsg(),
            userMsg(),
            asstMsg(),
        ];
        const state = makeState(history, 1000);
        const ctx = makeCtx(state);
        const result = await snip.run(ctx);
        expect(result).toBe("applied");
        expect(state.shapingFlags.snip).toBe(true);
        const snippedMsg = state.history[2];
        expect(snippedMsg?.role).toBe("tool");
        expect(snippedMsg?.content).toBe(SNIP_STUB);
        expect(snippedMsg?.tool_call_id).toBe("call_1");
        expect(ctx.budget.tokensFreedThisTurn).toBeGreaterThan(0);
    });

    it("preserves tool_call_id (orphan-pairing regression guard)", async () => {
        const history: Message[] = [
            userMsg(),
            asstMsg(),
            big("call_xyz", 4000),
            asstMsg(),
            ...Array.from({ length: 8 }, (_, i) =>
                i % 2 === 0 ? userMsg(`u${i}`) : asstMsg(`a${i}`),
            ),
        ];
        const state = makeState(history, 1000);
        await snip.run(makeCtx(state));
        const snipped = state.history[2];
        expect(snipped?.tool_call_id).toBe("call_xyz");
    });

    it("respects snipMaxPerTurn", async () => {
        const history: Message[] = [
            ...Array.from({ length: 20 }, (_, i) => big(`call_${i}`, 1000)),
            // protected tail
            ...Array.from({ length: 8 }, () => userMsg()),
        ];
        const state = makeState(history, 500);
        const config = {
            compact: { threshold: 0.5, snipMaxPerTurn: 3 },
        } as unknown as Config;
        const result = await snip.run(makeCtx(state, config));
        expect(result).toBe("applied");
        const snippedCount = state.history.filter((m) => m.content === SNIP_STUB).length;
        expect(snippedCount).toBe(3);
    });

    it("is idempotent within a turn (one-shot flag)", async () => {
        const history: Message[] = [
            userMsg(),
            asstMsg(),
            big("call_1", 4000),
            asstMsg(),
            ...Array.from({ length: 8 }, (_, i) =>
                i % 2 === 0 ? userMsg(`u${i}`) : asstMsg(`a${i}`),
            ),
        ];
        const state = makeState(history, 1000);
        const ctx = makeCtx(state);
        const first = await snip.run(ctx);
        expect(first).toBe("applied");
        const second = await snip.run(ctx);
        expect(second).toBe("skip");
    });

    it("does not touch user/assistant messages even if larger than tool results", async () => {
        const history: Message[] = [
            userMsg("u".repeat(8000)),
            asstMsg("a".repeat(8000)),
            big("call_1", 1000),
            asstMsg(),
            ...Array.from({ length: 8 }, () => userMsg()),
        ];
        const state = makeState(history, 1000);
        await snip.run(makeCtx(state));
        expect(state.history[0]?.role).toBe("user");
        expect(state.history[0]?.content).toBe("u".repeat(8000));
        expect(state.history[1]?.role).toBe("assistant");
        expect(state.history[1]?.content).toBe("a".repeat(8000));
    });

    it("excludes messages with stub content from re-snipping", async () => {
        const history: Message[] = [
            userMsg(),
            asstMsg(),
            { role: "tool", tool_call_id: "old_stub", content: SNIP_STUB },
            big("call_1", 4000),
            asstMsg(),
            ...Array.from({ length: 8 }, () => userMsg()),
        ];
        const state = makeState(history, 1000);
        await snip.run(makeCtx(state));
        expect(state.history[2]?.content).toBe(SNIP_STUB);
        expect(state.history[2]?.tool_call_id).toBe("old_stub");
        expect(state.history[3]?.content).toBe(SNIP_STUB);
    });
});
