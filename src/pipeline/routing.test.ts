import { describe, expect, test } from "bun:test";
import type { Config } from "../config/index.ts";
import { DEFAULT_CONFIG } from "../config/index.ts";
import { capturePinnedUpstream, clearPinnedUpstreams, resolveProviderOptions } from "./routing.ts";
import { newShapingFlags, newTurnState, type SessionState } from "./state.ts";

const makeState = (overrides: Partial<SessionState> = {}): SessionState => ({
    sessionId: "s",
    projectId: "p",
    projectRoot: "/tmp",
    mode: "NORMAL",
    contextWindow: 100_000,
    history: [],
    sessionRules: [],
    denialTrail: null,
    compactedThisTurn: false,
    shapingFlags: newShapingFlags(),
    globalTurnIndex: 0,
    selectedMemory: null,
    headless: false,
    turnState: newTurnState(),
    ...overrides,
});

const withRouting = (routing: Config["defaultModel"]["routing"]): Config => ({
    ...DEFAULT_CONFIG,
    defaultModel: { ...DEFAULT_CONFIG.defaultModel, routing },
});

describe("resolveProviderOptions", () => {
    test("default → cheapest → providerSort: price", () => {
        const cfg = { ...DEFAULT_CONFIG, defaultModel: { ...DEFAULT_CONFIG.defaultModel } };
        // Remove the explicit routing to test default fallback.
        delete (cfg.defaultModel as { routing?: unknown }).routing;
        const out = resolveProviderOptions(cfg, makeState(), "anything");
        expect(out.providerSort).toBe("price");
        expect(out.providerOrder).toBeUndefined();
    });

    test("cheapest → price", () => {
        const out = resolveProviderOptions(withRouting("cheapest"), makeState(), "m");
        expect(out.providerSort).toBe("price");
    });

    test("fastest → throughput", () => {
        const out = resolveProviderOptions(withRouting("fastest"), makeState(), "m");
        expect(out.providerSort).toBe("throughput");
    });

    test("latency → latency", () => {
        const out = resolveProviderOptions(withRouting("latency"), makeState(), "m");
        expect(out.providerSort).toBe("latency");
    });

    test("sticky with no pin yet → falls back to price", () => {
        const out = resolveProviderOptions(withRouting("sticky"), makeState(), "m");
        expect(out.providerSort).toBe("price");
        expect(out.providerOrder).toBeUndefined();
    });

    test("sticky with pinned upstream → providerOrder includes only that upstream", () => {
        const state = makeState({ pinnedUpstream: { "deepseek/deepseek-v4-pro": "DeepInfra" } });
        const out = resolveProviderOptions(
            withRouting("sticky"),
            state,
            "deepseek/deepseek-v4-pro",
        );
        expect(out.providerOrder).toEqual(["DeepInfra"]);
        expect(out.providerSort).toBeUndefined();
    });

    test("sticky pin is scoped per model — different model falls back", () => {
        const state = makeState({ pinnedUpstream: { modelA: "DeepInfra" } });
        const out = resolveProviderOptions(withRouting("sticky"), state, "modelB");
        expect(out.providerOrder).toBeUndefined();
        expect(out.providerSort).toBe("price");
    });

    test("explicit providerOrder in config beats routing strategy", () => {
        const cfg: Config = {
            ...DEFAULT_CONFIG,
            defaultModel: {
                ...DEFAULT_CONFIG.defaultModel,
                providerOrder: ["AtlasCloud"],
                routing: "fastest",
            },
        };
        const out = resolveProviderOptions(cfg, makeState(), "m");
        expect(out.providerOrder).toEqual(["AtlasCloud"]);
        expect(out.providerSort).toBeUndefined();
    });

    test("explicit providerSort beats routing strategy (legacy)", () => {
        const cfg: Config = {
            ...DEFAULT_CONFIG,
            defaultModel: {
                ...DEFAULT_CONFIG.defaultModel,
                providerSort: "latency",
                routing: "cheapest",
            },
        };
        const out = resolveProviderOptions(cfg, makeState(), "m");
        expect(out.providerSort).toBe("latency");
    });

    test("allowFallbacks is preserved when set", () => {
        const cfg: Config = {
            ...DEFAULT_CONFIG,
            defaultModel: {
                ...DEFAULT_CONFIG.defaultModel,
                allowFallbacks: false,
                routing: "fastest",
            },
        };
        const out = resolveProviderOptions(cfg, makeState(), "m");
        expect(out.allowFallbacks).toBe(false);
    });
});

describe("capturePinnedUpstream", () => {
    test("captures the first upstream for a model under sticky routing", () => {
        const state = makeState();
        const cfg = withRouting("sticky");
        capturePinnedUpstream(state, cfg, "modelA", "DeepInfra");
        expect(state.pinnedUpstream?.["modelA"]).toBe("DeepInfra");
    });

    test("does not overwrite an existing pin", () => {
        const state = makeState({ pinnedUpstream: { modelA: "DeepInfra" } });
        const cfg = withRouting("sticky");
        capturePinnedUpstream(state, cfg, "modelA", "Novita");
        expect(state.pinnedUpstream?.["modelA"]).toBe("DeepInfra");
    });

    test("no-op when routing is not sticky", () => {
        const state = makeState();
        const cfg = withRouting("cheapest");
        capturePinnedUpstream(state, cfg, "modelA", "DeepInfra");
        expect(state.pinnedUpstream).toBeUndefined();
    });

    test("multi-model pinning keeps prior model's pin intact", () => {
        const state = makeState();
        const cfg = withRouting("sticky");
        capturePinnedUpstream(state, cfg, "modelA", "DeepInfra");
        capturePinnedUpstream(state, cfg, "modelB", "Novita");
        expect(state.pinnedUpstream).toEqual({ modelA: "DeepInfra", modelB: "Novita" });
    });
});

describe("clearPinnedUpstreams", () => {
    test("wipes all pins", () => {
        const state = makeState({ pinnedUpstream: { a: "x", b: "y" } });
        clearPinnedUpstreams(state);
        expect(state.pinnedUpstream).toBeUndefined();
    });
});
