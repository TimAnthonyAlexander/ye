import type { Config } from "../config/index.ts";
import type { Event } from "../pipeline/events.ts";
import type { Provider } from "../providers/index.ts";
import { resolveAgent } from "./catalogue.ts";
import { runInProcess } from "./isolate/inProcess.ts";
import { SubagentError, type SubagentResult, type SubagentSpec } from "./types.ts";

export type {
    AgentSource,
    BuiltinKind,
    ExploreOptions,
    ExploreThoroughness,
    SubagentKind,
    SubagentResult,
    SubagentSpec,
} from "./types.ts";
export { BUILTIN_KINDS, SubagentError } from "./types.ts";
export {
    CUSTOM_AGENT_TOOL_CEILING,
    buildAgentCatalogue,
    getAgentCatalogue,
    isKnownKind,
    listAgents,
    resetAgentCatalogue,
    resolveAgent,
    unknownKindError,
    type AgentCatalogue,
    type AgentEntry,
    type ResolvedAgent,
} from "./catalogue.ts";
export { copyForkHistory } from "./forkSeed.ts";

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

export const subagentBudgetFor = (config: Config): number => config.maxTurns?.subagent ?? 25;

export const spawn = async (spec: SubagentSpec, ctx: SpawnContext): Promise<SubagentResult> => {
    if (typeof spec.prompt !== "string" || spec.prompt.trim().length === 0) {
        throw new SubagentError("subagent prompt must be a non-empty string");
    }
    const resolved = resolveAgent(spec, ctx.parentProjectRoot, subagentBudgetFor(ctx.config));

    return await runInProcess({
        parentProjectId: ctx.parentProjectId,
        parentProjectRoot: ctx.parentProjectRoot,
        parentSessionId: ctx.parentSessionId,
        contextWindow: ctx.contextWindow,
        prompt: resolved.userPrompt,
        systemPrompt: resolved.systemPrompt,
        allowedTools: resolved.allowedTools,
        maxTurns: resolved.maxTurns,
        seedHistory: resolved.seedHistory,
        config: ctx.config,
        provider: ctx.provider,
        signal: ctx.signal,
        ...(resolved.model !== undefined ? { model: resolved.model } : {}),
        ...(ctx.onChildEvent ? { onChildEvent: ctx.onChildEvent } : {}),
    });
};
