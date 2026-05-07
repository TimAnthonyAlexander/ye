import type { Config } from "../../config/index.ts";
import type { Event } from "../../pipeline/events.ts";
import { queryLoop, type SessionState } from "../../pipeline/index.ts";
import type { Provider } from "../../providers/index.ts";
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
        history: [],
        sessionRules: [],
        denialTrail: null,
        compactedThisTurn: false,
        selectedMemory: [],
        parentSessionId: input.parentSessionId,
        allowedTools: input.allowedTools,
        systemPromptOverride: input.systemPrompt,
    };

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
            if (evt.type === "turn.end" && evt.error !== undefined) errorMessage = evt.error;
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

    const finalAssistant = [...subState.history]
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
