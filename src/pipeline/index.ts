import { FALLBACK_CONTEXT_WINDOW, type Config } from "../config/index.ts";
import type { Message, Provider } from "../providers/index.ts";
import { openSession, type SessionHandle } from "../storage/index.ts";
import type { Event, StopReason } from "./events.ts";
import { newShapingFlags, newTurnState, type SessionState } from "./state.ts";
import { runTurn } from "./turn.ts";

export type { Event, StopReason } from "./events.ts";
export { newShapingFlags, newTurnState, resetShapingFlags } from "./state.ts";
export type { SessionState } from "./state.ts";

export interface CreateSessionInput {
    readonly provider: Provider;
    readonly config: Config;
    readonly projectId: string;
    readonly projectRoot: string;
}

// Build session state once per Ink session. Caller passes it back into queryLoop
// for each user prompt. Mode mutates here; callers (UI keybinds) treat it as the
// single source of truth for current mode.
export const createSessionState = async (
    input: CreateSessionInput,
): Promise<{ state: SessionState; session: SessionHandle }> => {
    const session = await openSession(input.projectId);
    let contextWindow = FALLBACK_CONTEXT_WINDOW;
    try {
        contextWindow = await input.provider.getContextSize(input.config.defaultModel.model);
    } catch {
        // keep fallback
    }
    const state: SessionState = {
        sessionId: session.sessionId,
        projectId: input.projectId,
        projectRoot: input.projectRoot,
        mode: input.config.permissions?.defaultMode ?? "NORMAL",
        contextWindow,
        history: [],
        sessionRules: [],
        denialTrail: null,
        compactedThisTurn: false,
        shapingFlags: newShapingFlags(),
        globalTurnIndex: 0,
        selectedMemory: null,
        turnState: newTurnState(),
    };
    return { state, session };
};

export interface QueryLoopInput {
    readonly provider: Provider;
    readonly config: Config;
    readonly state: SessionState;
    readonly session: SessionHandle;
    readonly userPrompt: string;
    readonly signal?: AbortSignal;
    // Override the per-loop turn budget (subagents pass their own narrower limit).
    readonly maxTurnsOverride?: number;
}

// Drives turns until a terminal stop reason fires. Yields all turn events
// to the caller.
export async function* queryLoop(input: QueryLoopInput): AsyncGenerator<Event> {
    const userMessage: Message = { role: "user", content: input.userPrompt };
    input.state.history.push(userMessage);
    // The first runTurn inside this prompt will bump globalTurnIndex by 1.
    // Recording it now lets /rewind map "user message N" → "first turn that
    // ran for it = checkpoint to revert against".
    const firstTurnGlobalIdx = input.state.globalTurnIndex + 1;
    await input.session.appendEvent({ type: "user.message", content: input.userPrompt });
    await input.session.appendEvent({
        type: "prompt.start",
        firstTurnGlobalIdx,
        preview: input.userPrompt.slice(0, 80),
    });

    const maxTurns = input.maxTurnsOverride ?? input.config.maxTurns?.master ?? 100;
    const signal = input.signal ?? new AbortController().signal;

    // Read/Edit/Write hash tracking and TodoWrite list live on SessionState
    // so they persist across user prompts within a single session — the
    // typical "Read README, then user follows up with 'Edit README'" pattern
    // shouldn't re-Read. Edit/Write re-hash the file before writing to catch
    // any external drift, so persistence is safe.
    const turnState = input.state.turnState;

    let turnIndex = 0;
    while (turnIndex < maxTurns) {
        const turn = runTurn({
            provider: input.provider,
            config: input.config,
            session: input.session,
            state: input.state,
            turnState,
            turnIndex,
            maxTurns,
            signal,
        });

        let stopReason: StopReason | undefined;
        while (true) {
            const next = await turn.next();
            if (next.done) {
                stopReason = next.value;
                break;
            }
            yield next.value;
        }

        if (stopReason !== "continue") return;
        turnIndex += 1;
    }
}
