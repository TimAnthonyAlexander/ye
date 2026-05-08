import { describe, expect, it } from "bun:test";
import type { Config } from "../../config/index.ts";
import type { Message, Provider } from "../../providers/index.ts";
import type { SessionState } from "../state.ts";
import { newShapingFlags } from "../state.ts";
import { MICROCOMPACT_PREFIX, microcompact } from "./microcompact.ts";
import { SNIP_STUB } from "./snip.ts";
import type { RequestBudget, ShaperContext } from "./types.ts";

const stubProvider = {} as unknown as Provider;

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

const makeCtx = (state: SessionState, config: Config = {} as Config): ShaperContext => ({
    state,
    messages: state.history,
    provider: stubProvider,
    config,
    model: "test",
    budget: makeBudget(),
});

const userMsg = (content = "hi"): Message => ({ role: "user", content });
const asstWithCall = (callId: string, name: string): Message => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id: callId, type: "function", function: { name, arguments: "{}" } }],
});
const toolResult = (callId: string, content: string): Message => ({
    role: "tool",
    tool_call_id: callId,
    content,
});

describe("microcompact", () => {
    it("skips when below threshold", async () => {
        const history = [userMsg(), asstWithCall("c1", "Read"), toolResult("c1", "x".repeat(2000))];
        const state = makeState(history, 1_000_000);
        const result = await microcompact.run(makeCtx(state));
        expect(result).toBe("skip");
        expect(state.shapingFlags.microcompact).toBe(false);
    });

    it("truncates old large tool results, preserving tool_call_id", async () => {
        const history: Message[] = [
            userMsg(),
            asstWithCall("c1", "Read"),
            toolResult("c1", "x".repeat(4000)),
            ...Array.from({ length: 6 }, () => userMsg()),
        ];
        const state = makeState(history, 1000);
        const ctx = makeCtx(state);
        const result = await microcompact.run(ctx);
        expect(result).toBe("applied");
        const truncated = state.history[2];
        expect(truncated?.role).toBe("tool");
        expect(truncated?.tool_call_id).toBe("c1");
        expect(truncated?.content).toContain(MICROCOMPACT_PREFIX);
        expect(truncated?.content).toContain("tool=Read");
        expect(truncated?.content).toContain("id=c1");
        expect(truncated?.content).toContain("size≈4000B");
        expect(ctx.budget.tokensFreedThisTurn).toBeGreaterThan(0);
    });

    it("honors hot tail (recent tool results untouched)", async () => {
        const history: Message[] = [
            userMsg(),
            asstWithCall("c1", "Read"),
            toolResult("c1", "x".repeat(4000)),
            asstWithCall("c2", "Bash"),
            toolResult("c2", "y".repeat(4000)),
            userMsg(),
        ];
        const state = makeState(history, 1000);
        await microcompact.run(makeCtx(state));
        // hot tail = 6, so all messages are inside the tail and nothing gets touched
        expect(state.history[2]?.content).toBe("x".repeat(4000));
        expect(state.history[4]?.content).toBe("y".repeat(4000));
    });

    it("honors size floor (small tool results untouched)", async () => {
        const history: Message[] = [
            userMsg(),
            asstWithCall("c1", "Read"),
            toolResult("c1", "small"),
            ...Array.from({ length: 6 }, () => userMsg()),
        ];
        const state = makeState(history, 100);
        const result = await microcompact.run(makeCtx(state));
        expect(result).toBe("skip");
    });

    it("looks up tool name correctly", async () => {
        const history: Message[] = [
            userMsg(),
            asstWithCall("call_a", "Bash"),
            toolResult("call_a", "z".repeat(2000)),
            ...Array.from({ length: 6 }, () => userMsg()),
        ];
        const state = makeState(history, 800);
        await microcompact.run(makeCtx(state));
        expect(state.history[2]?.content).toContain("tool=Bash");
    });

    it("skips already-shaped messages (snipped or microcompacted)", async () => {
        const history: Message[] = [
            userMsg(),
            asstWithCall("c1", "Read"),
            { role: "tool", tool_call_id: "c1", content: SNIP_STUB },
            asstWithCall("c2", "Read"),
            { role: "tool", tool_call_id: "c2", content: `${MICROCOMPACT_PREFIX} ...]` },
            ...Array.from({ length: 6 }, () => userMsg()),
        ];
        const state = makeState(history, 100);
        const result = await microcompact.run(makeCtx(state));
        expect(result).toBe("skip");
        expect(state.history[2]?.content).toBe(SNIP_STUB);
    });

    it("is idempotent within a turn (one-shot flag)", async () => {
        const history: Message[] = [
            userMsg(),
            asstWithCall("c1", "Read"),
            toolResult("c1", "x".repeat(4000)),
            ...Array.from({ length: 6 }, () => userMsg()),
        ];
        const state = makeState(history, 1000);
        const ctx = makeCtx(state);
        const first = await microcompact.run(ctx);
        expect(first).toBe("applied");
        const second = await microcompact.run(ctx);
        expect(second).toBe("skip");
    });

    it("falls back to 'unknown' when tool name lookup fails", async () => {
        const history: Message[] = [
            userMsg(),
            // No assistant tool_calls preceded — orphan tool message (degenerate
            // but defensive)
            toolResult("orphan_id", "z".repeat(4000)),
            ...Array.from({ length: 6 }, () => userMsg()),
        ];
        const state = makeState(history, 800);
        await microcompact.run(makeCtx(state));
        expect(state.history[1]?.content).toContain("tool=unknown");
    });
});
