import type { Config } from "../config/index.ts";
import type { Event } from "../pipeline/events.ts";
import type { Provider } from "../providers/index.ts";
import { EXPLORE_TOOLS, exploreSystemPrompt, exploreTurnBudget } from "./kinds/explore.ts";
import { GENERAL_TOOLS, generalSystemPrompt, generalTurnBudget } from "./kinds/general.ts";
import { runInProcess } from "./isolate/inProcess.ts";
import {
    SubagentError,
    type SubagentKind,
    type SubagentResult,
    type SubagentSpec,
} from "./types.ts";

export type {
    ExploreOptions,
    ExploreThoroughness,
    SubagentKind,
    SubagentResult,
    SubagentSpec,
} from "./types.ts";
export { SubagentError } from "./types.ts";

export interface SpawnContext {
    readonly parentProjectId: string;
    readonly parentProjectRoot: string;
    readonly parentSessionId: string;
    readonly contextWindow: number;
    readonly config: Config;
    readonly provider: Provider;
    readonly signal: AbortSignal;
    // Fires for every event the subagent's queryLoop yields (turn boundaries,
    // tool starts/ends, model text, etc.). Used by the parent's Task tool to
    // build live action-line progress for the UI.
    readonly onChildEvent?: (evt: Event) => void;
}

interface KindResolution {
    readonly systemPrompt: string;
    readonly allowedTools: readonly string[];
    readonly maxTurns: number;
}

const resolveKind = (spec: SubagentSpec, cwd: string, subagentBudget: number): KindResolution => {
    switch (spec.kind) {
        case "explore": {
            const budget = Math.min(exploreTurnBudget(spec.options?.thoroughness), subagentBudget);
            return {
                systemPrompt: exploreSystemPrompt(cwd),
                allowedTools: EXPLORE_TOOLS,
                maxTurns: budget,
            };
        }
        case "general": {
            return {
                systemPrompt: generalSystemPrompt(cwd),
                allowedTools: GENERAL_TOOLS,
                maxTurns: Math.min(generalTurnBudget, subagentBudget),
            };
        }
    }
};

export const spawn = async (
    spec: SubagentSpec,
    ctx: SpawnContext,
): Promise<SubagentResult> => {
    if (typeof spec.prompt !== "string" || spec.prompt.trim().length === 0) {
        throw new SubagentError("subagent prompt must be a non-empty string");
    }
    const subagentBudget = ctx.config.maxTurns?.subagent ?? 25;
    const resolved = resolveKind(spec, ctx.parentProjectRoot, subagentBudget);

    return await runInProcess({
        parentProjectId: ctx.parentProjectId,
        parentProjectRoot: ctx.parentProjectRoot,
        parentSessionId: ctx.parentSessionId,
        contextWindow: ctx.contextWindow,
        prompt: spec.prompt,
        systemPrompt: resolved.systemPrompt,
        allowedTools: resolved.allowedTools,
        maxTurns: resolved.maxTurns,
        config: ctx.config,
        provider: ctx.provider,
        signal: ctx.signal,
        ...(ctx.onChildEvent ? { onChildEvent: ctx.onChildEvent } : {}),
    });
};

export const isSubagentKind = (value: unknown): value is SubagentKind =>
    value === "explore" || value === "general";
