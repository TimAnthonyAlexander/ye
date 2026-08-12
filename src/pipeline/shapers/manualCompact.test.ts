import { describe, expect, it } from "bun:test";
import type { Config } from "../../config/index.ts";
import type { Message, Provider, ProviderEvent } from "../../providers/index.ts";
import type { SessionState } from "../state.ts";
import { newShapingFlags } from "../state.ts";
import { runManualCompact } from "./manualCompact.ts";

let lastPrompt = "";

const provider = (summary: string): Provider =>
    ({
        id: "test",
        capabilities: { serverSideWebSearch: false },
        getContextSize: async () => 200_000,
        stream: async function* (input: {
            messages: readonly Message[];
        }): AsyncGenerator<ProviderEvent> {
            lastPrompt = input.messages[input.messages.length - 1]?.content ?? "";
            yield { type: "text.delta", text: summary };
            yield { type: "stop", reason: "end_turn" };
        },
    }) as unknown as Provider;

const makeState = (history: Message[]): SessionState =>
    ({
        sessionId: "s",
        projectId: "p",
        projectRoot: "/tmp",
        mode: "AUTO",
        contextWindow: 200_000,
        history,
        sessionRules: [],
        denialTrail: null,
        compactedThisTurn: false,
        ghostWaitFiredThisPrompt: false,
    ghostWaitSuppressNext: false,
        shapingFlags: newShapingFlags(),
        selectedMemory: [],
        turnState: { readFiles: new Map(), todos: [] },
    }) as unknown as SessionState;

const config = {
    defaultModel: { provider: "test", model: "m" },
} as unknown as Config;

const longHistory = (): Message[] =>
    Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: "x".repeat(2000),
    }));

describe("runManualCompact", () => {
    it("replaces older history with the summary regardless of any threshold", async () => {
        const state = makeState(longHistory());
        const result = await runManualCompact({
            state,
            provider: provider("the summary"),
            config,
            model: "m",
            focus: "",
        });
        expect(result.status).toBe("compacted");
        expect(result.afterTokens).toBeLessThan(result.beforeTokens);
        expect(state.history).toHaveLength(5);
        expect(state.history[0]?.role).toBe("system");
        expect(state.history[0]?.content).toContain("the summary");
    });

    it("steers the summarizer prompt with the focus text", async () => {
        lastPrompt = "";
        await runManualCompact({
            state: makeState(longHistory()),
            provider: provider("summary"),
            config,
            model: "m",
            focus: "the auth refactor",
        });
        expect(lastPrompt).toContain("the auth refactor");
    });

    it("skips when there is not enough history to summarize", async () => {
        const state = makeState([{ role: "user", content: "hi" }]);
        const result = await runManualCompact({
            state,
            provider: provider("summary"),
            config,
            model: "m",
            focus: "",
        });
        expect(result.status).toBe("skipped");
        expect(state.history).toHaveLength(1);
    });
});
