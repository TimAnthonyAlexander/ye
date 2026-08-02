import type { Message } from "../providers/index.ts";
import { loadCustomAgents } from "./custom/load.ts";
import { copyForkHistory } from "./forkSeed.ts";
import { EXPLORE_TOOLS, exploreSystemPrompt, exploreTurnBudget } from "./kinds/explore.ts";
import { FORK_TOOLS, forkSystemPrompt, forkTaskMessage, forkTurnBudget } from "./kinds/fork.ts";
import { GENERAL_TOOLS, generalSystemPrompt, generalTurnBudget } from "./kinds/general.ts";
import {
    VERIFICATION_TOOLS,
    verificationSystemPrompt,
    verificationTurnBudget,
} from "./kinds/verification.ts";
import { buildCustomAgentPrompt } from "./systemPrompts.ts";
import { SubagentError, type AgentSource, type SubagentSpec } from "./types.ts";

export interface AgentEntry {
    readonly name: string;
    readonly description: string;
    readonly source: AgentSource;
    readonly tools: readonly string[];
    readonly maxTurns: number;
    // Display-only. `explore` is the one kind whose budget depends on an
    // argument, so a single number can't describe it.
    readonly turnsLabel: string;
    readonly path: string | null;
    readonly model?: string;
    readonly body?: string;
}

export interface AgentCatalogue {
    readonly root: string;
    readonly byName: ReadonlyMap<string, AgentEntry>;
    readonly list: readonly AgentEntry[];
}

// The widest surface a markdown-declared agent can reach: the union of what the
// built-in kinds may use. Task is excluded unconditionally — a subagent that
// could call Task could spawn subagents forever.
export const CUSTOM_AGENT_TOOL_CEILING: readonly string[] = [
    ...new Set([...EXPLORE_TOOLS, ...GENERAL_TOOLS, ...VERIFICATION_TOOLS]),
].filter((name) => name !== "Task");

export const intersectTools = (
    declared: readonly string[],
    ceiling: readonly string[],
): readonly string[] => declared.filter((name) => ceiling.includes(name));

const builtinEntries = (): readonly AgentEntry[] => [
    {
        name: "explore",
        description: "Read-only codebase search. Returns a written summary.",
        source: "builtin",
        tools: EXPLORE_TOOLS,
        maxTurns: exploreTurnBudget(undefined),
        turnsLabel: `${exploreTurnBudget("quick")} quick / ${exploreTurnBudget(
            "medium",
        )} medium / ${exploreTurnBudget("very_thorough")} very_thorough`,
        path: null,
    },
    {
        name: "general",
        description: "Full subagent toolset, AUTO mode, fresh context.",
        source: "builtin",
        tools: GENERAL_TOOLS,
        maxTurns: generalTurnBudget,
        turnsLabel: String(generalTurnBudget),
        path: null,
    },
    {
        name: "verification",
        description: "Adversarial post-change verification (typecheck, tests, diff).",
        source: "builtin",
        tools: VERIFICATION_TOOLS,
        maxTurns: verificationTurnBudget,
        turnsLabel: String(verificationTurnBudget),
        path: null,
    },
    {
        name: "fork",
        description: "Same toolset as general, but starts from a copy of this conversation.",
        source: "builtin",
        tools: FORK_TOOLS,
        maxTurns: forkTurnBudget,
        turnsLabel: String(forkTurnBudget),
        path: null,
    },
];

export const buildAgentCatalogue = (projectRoot: string): AgentCatalogue => {
    const byName = new Map<string, AgentEntry>();
    for (const agent of loadCustomAgents(projectRoot)) {
        byName.set(agent.name, {
            name: agent.name,
            description: agent.description,
            source: agent.source,
            tools:
                agent.tools !== undefined
                    ? intersectTools(agent.tools, CUSTOM_AGENT_TOOL_CEILING)
                    : CUSTOM_AGENT_TOOL_CEILING,
            maxTurns: agent.maxTurns ?? generalTurnBudget,
            turnsLabel: String(agent.maxTurns ?? generalTurnBudget),
            path: agent.path,
            ...(agent.model !== undefined ? { model: agent.model } : {}),
            body: agent.body,
        });
    }
    // Built-ins land last so no markdown file can shadow one.
    for (const entry of builtinEntries()) byName.set(entry.name, entry);

    return {
        root: projectRoot,
        byName,
        list: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
};

let cache: AgentCatalogue | null = null;

export const getAgentCatalogue = (projectRoot: string = process.cwd()): AgentCatalogue => {
    if (cache !== null && cache.root === projectRoot) return cache;
    cache = buildAgentCatalogue(projectRoot);
    return cache;
};

export const resetAgentCatalogue = (): void => {
    cache = null;
};

export const listAgents = (projectRoot?: string): readonly AgentEntry[] =>
    getAgentCatalogue(projectRoot).list;

export const isKnownKind = (kind: unknown, projectRoot?: string): kind is string =>
    typeof kind === "string" && getAgentCatalogue(projectRoot).byName.has(kind);

export const unknownKindError = (kind: unknown, projectRoot?: string): string => {
    const valid = listAgents(projectRoot)
        .map((a) => a.name)
        .join(", ");
    return `unknown subagent kind: ${String(kind)}. Valid kinds: ${valid}`;
};

export interface ResolvedAgent {
    readonly systemPrompt: string;
    readonly allowedTools: readonly string[];
    readonly maxTurns: number;
    readonly userPrompt: string;
    readonly seedHistory: readonly Message[];
    readonly model?: string;
}

export const resolveAgent = (
    spec: SubagentSpec,
    cwd: string,
    subagentBudget: number,
): ResolvedAgent => {
    const entry = getAgentCatalogue(cwd).byName.get(spec.kind);
    if (entry === undefined) {
        throw new SubagentError(unknownKindError(spec.kind, cwd));
    }

    const base = {
        allowedTools: entry.tools,
        maxTurns: Math.min(entry.maxTurns, subagentBudget),
        userPrompt: spec.prompt,
        seedHistory: [] as readonly Message[],
    };

    if (entry.source !== "builtin") {
        return {
            ...base,
            systemPrompt: buildCustomAgentPrompt(entry.body ?? "", cwd, entry.tools),
            ...(entry.model !== undefined ? { model: entry.model } : {}),
        };
    }

    switch (entry.name) {
        case "explore":
            return {
                ...base,
                systemPrompt: exploreSystemPrompt(cwd),
                maxTurns: Math.min(exploreTurnBudget(spec.options?.thoroughness), subagentBudget),
            };
        case "verification":
            return { ...base, systemPrompt: verificationSystemPrompt(cwd) };
        case "fork":
            return {
                ...base,
                systemPrompt: forkSystemPrompt(cwd),
                userPrompt: forkTaskMessage(spec.prompt),
                seedHistory: copyForkHistory(spec.seedHistory ?? []),
            };
        default:
            return { ...base, systemPrompt: generalSystemPrompt(cwd) };
    }
};
