import type { Config } from "../../config/index.ts";
import { runEventHooks } from "../../hooks/index.ts";
import type { Event } from "../../pipeline/events.ts";
import {
    newShapingFlags,
    newTurnState,
    queryLoop,
    type SessionState,
} from "../../pipeline/index.ts";
import type { Message, Provider } from "../../providers/index.ts";
import { openSidechainSession } from "../../storage/index.ts";
import { SubagentError, type SubagentResult } from "../types.ts";

export interface InProcessRun {
    readonly parentProjectId: string;
    readonly parentProjectRoot: string;
    readonly parentSessionId: string;
    readonly contextWindow: number;
    readonly prompt: string;
    readonly systemPrompt: string;
    readonly allowedTools: readonly string[];
    readonly maxTurns: number;
    // Starting history for kinds that inherit context (fork). Already deep-copied
    // by the resolver, so the subagent's shapers can mutate it freely.
    readonly seedHistory?: readonly Message[];
    readonly model?: string;
    readonly config: Config;
    readonly provider: Provider;
    readonly signal: AbortSignal;
    readonly onChildEvent?: (evt: Event) => void;
}

export const runInProcess = async (input: InProcessRun): Promise<SubagentResult> => {
    const session = await openSidechainSession(input.parentProjectId, input.parentSessionId);

    const subState: SessionState = {
        sessionId: session.sessionId,
        projectId: input.parentProjectId,
        projectRoot: input.parentProjectRoot,
        mode: "AUTO",
        contextWindow: input.contextWindow,
        history: [...(input.seedHistory ?? [])],
        sessionRules: [],
        denialTrail: null,
        compactedThisTurn: false,
        shapingFlags: newShapingFlags(),
        globalTurnIndex: 0,
        selectedMemory: [],
        headless: false,
        turnState: newTurnState(),
        parentSessionId: input.parentSessionId,
        allowedTools: input.allowedTools,
        systemPromptOverride: input.systemPrompt,
        ...(input.model !== undefined ? { activeModel: input.model } : {}),
    };

    // Everything below this index is the subagent's own output. Without it, a
    // seeded fork that produces no text would return one of the parent's own
    // assistant messages as its summary.
    const seedLength = subState.history.length;
    let turnCount = 0;
    let errorMessage: string | undefined;

    try {
        for await (const evt of queryLoop({
            provider: input.provider,
            config: input.config,
            state: subState,
            session,
            userPrompt: input.prompt,
            signal: input.signal,
            maxTurnsOverride: input.maxTurns,
        })) {
            input.onChildEvent?.(evt);
            if (evt.type === "turn.start") turnCount = evt.turnIndex + 1;
            if (evt.type === "turn.end" && evt.error !== undefined)
                errorMessage = evt.error.message;
            // Subagents force AUTO mode and have a narrowed tool pool, so prompts
            // shouldn't fire. Defensive: deny anything that does.
            if (evt.type === "permission.prompt") evt.respond("deny");
        }
    } finally {
        await session.close();
    }

    if (errorMessage) {
        throw new SubagentError(`subagent failed: ${errorMessage}`);
    }

    // SubagentStop hook: fire-and-forget after subagent completes.
    void runEventHooks(
        input.config.hooks,
        "SubagentStop",
        { project_dir: input.parentProjectRoot },
        new AbortController().signal,
    );

    // A shaper may have replaced history wholesale, leaving it shorter than the
    // seed — then everything that survived is already the subagent's own tail.
    const own =
        subState.history.length >= seedLength
            ? subState.history.slice(seedLength)
            : subState.history;
    const finalAssistant = [...own]
        .reverse()
        .find(
            (m) => m.role === "assistant" && typeof m.content === "string" && m.content.length > 0,
        );
    const summary =
        finalAssistant && typeof finalAssistant.content === "string"
            ? finalAssistant.content
            : "(subagent produced no final message)";

    return { summary, transcriptPath: session.path, turnCount };
};
