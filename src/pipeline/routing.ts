import type { Config, ProviderSort, RoutingStrategy } from "../config/index.ts";
import type { SessionState } from "./state.ts";

// providerOptions object built per turn. Forwarded into the OpenRouter
// adapter; other providers ignore these fields entirely. Shape is the open
// `Readonly<Record<string, unknown>>` recovery.ts expects, with typed alias
// names below for documentation.
export type ResolvedProviderOptions = Readonly<{
    readonly providerOrder?: readonly string[];
    readonly allowFallbacks?: boolean;
    readonly providerSort?: ProviderSort;
}> &
    Readonly<Record<string, unknown>>;

const ROUTING_TO_SORT: Record<Exclude<RoutingStrategy, "sticky">, ProviderSort> = {
    cheapest: "price",
    fastest: "throughput",
    latency: "latency",
};

// Resolve per-turn provider routing based on (in order of precedence):
//
//   1. Explicit `defaultModel.providerOrder` (advanced override, untouched)
//   2. Explicit `defaultModel.providerSort` (legacy override, kept for users
//      who set it directly before the routing field existed)
//   3. `defaultModel.routing` (user-facing /routing strategy)
//      - cheapest → price
//      - fastest  → throughput
//      - latency  → latency
//      - sticky   → providerOrder pinned to the upstream captured from the
//                   first usage event in this session for `activeModel`;
//                   falls back to "price" until a pin is captured
//   4. Default: cheapest / "price"
export const resolveProviderOptions = (
    config: Config,
    state: SessionState,
    activeModel: string,
): ResolvedProviderOptions => {
    const dm = config.defaultModel;
    const allow = dm.allowFallbacks;
    const withAllow = (out: ResolvedProviderOptions): ResolvedProviderOptions =>
        allow !== undefined ? { ...out, allowFallbacks: allow } : out;

    if (dm.providerOrder && dm.providerOrder.length > 0) {
        return withAllow({ providerOrder: dm.providerOrder });
    }
    if (dm.providerSort) {
        return withAllow({ providerSort: dm.providerSort });
    }

    const routing: RoutingStrategy = dm.routing ?? "cheapest";

    if (routing === "sticky") {
        const pinned = state.pinnedUpstream?.[activeModel];
        if (pinned) {
            return withAllow({ providerOrder: [pinned] });
        }
        return withAllow({ providerSort: "price" });
    }

    return withAllow({ providerSort: ROUTING_TO_SORT[routing] });
};

// Called after each model usage event. Captures the upstream provider for
// the active model on the first turn it appears, so subsequent turns can pin
// to the same upstream when routing strategy is "sticky".
export const capturePinnedUpstream = (
    state: SessionState,
    config: Config,
    activeModel: string,
    upstream: string,
): void => {
    if (config.defaultModel.routing !== "sticky") return;
    const current = state.pinnedUpstream ?? {};
    if (current[activeModel]) return;
    state.pinnedUpstream = { ...current, [activeModel]: upstream };
};

// Cleared on /model and /provider switches — pins are model-specific (you
// don't want yesterday's V4 Pro pin applied to today's Claude session).
export const clearPinnedUpstreams = (state: SessionState): void => {
    state.pinnedUpstream = undefined;
};
