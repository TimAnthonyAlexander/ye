import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import type { Config } from "../config/index.ts";
import { newShapingFlags } from "../pipeline/state.ts";
import type { SessionState } from "../pipeline/state.ts";
import type { Message, Provider, ProviderEvent } from "../providers/index.ts";
import { runAside } from "./aside.ts";

const provider = (chunks: readonly string[]): Provider =>
    ({
        id: "test",
        capabilities: { serverSideWebSearch: false },
        getContextSize: async () => 200_000,
        stream: async function* (): AsyncGenerator<ProviderEvent> {
            for (const text of chunks) yield { type: "text.delta", text };
            yield { type: "stop", reason: "end_turn" };
        },
    }) as unknown as Provider;

const makeState = (history: Message[]): SessionState =>
    ({
        sessionId: "s",
        projectId: "p",
        projectRoot: tmpdir(),
        mode: "NORMAL",
        contextWindow: 200_000,
        history,
        sessionRules: [],
        denialTrail: null,
        compactedThisTurn: false,
        ghostWaitFiredThisPrompt: false,
        shapingFlags: newShapingFlags(),
        selectedMemory: [],
        turnState: { readFiles: new Map(), todos: [] },
        headless: false,
        globalTurnIndex: 0,
    }) as unknown as SessionState;

const config = {
    defaultModel: { provider: "test", model: "m" },
} as unknown as Config;

const run = (state: SessionState, question = "what is the cwd?") =>
    runAside({
        state,
        provider: provider(["off ", "the ", "record"]),
        config,
        model: "m",
        question,
        onDelta: () => {},
    });

describe("runAside", () => {
    it("returns the streamed answer", async () => {
        const answer = await run(makeState([{ role: "user", content: "hi" }]));
        expect(answer).toBe("off the record");
    });

    it("leaves conversation history untouched", async () => {
        const history: Message[] = [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
        ];
        const state = makeState(history);
        const before = JSON.stringify(state.history);
        await run(state);
        expect(state.history).toHaveLength(2);
        expect(JSON.stringify(state.history)).toBe(before);
    });

    it("streams deltas to the caller", async () => {
        const seen: string[] = [];
        await runAside({
            state: makeState([]),
            provider: provider(["a", "b"]),
            config,
            model: "m",
            question: "q",
            onDelta: (d) => {
                seen.push(d);
            },
        });
        expect(seen).toEqual(["a", "b"]);
    });

    it("sends the question after the assembled context without storing it", async () => {
        let sentMessages: readonly Message[] = [];
        const capturing = {
            id: "test",
            capabilities: { serverSideWebSearch: false },
            getContextSize: async () => 200_000,
            stream: async function* (input: {
                messages: readonly Message[];
            }): AsyncGenerator<ProviderEvent> {
                sentMessages = input.messages;
                yield { type: "stop", reason: "end_turn" };
            },
        } as unknown as Provider;
        const state = makeState([{ role: "user", content: "earlier" }]);
        await runAside({
            state,
            provider: capturing,
            config,
            model: "m",
            question: "side question",
            onDelta: () => {},
        });
        const last = sentMessages[sentMessages.length - 1];
        expect(last?.role).toBe("user");
        expect(last?.content).toContain("side question");
        expect(state.history).toHaveLength(1);
    });
});
