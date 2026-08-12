import { FALLBACK_CONTEXT_WINDOW, type Config } from "../config/index.ts";
import type { Message, Provider } from "../providers/index.ts";
import { openSession, type SessionHandle } from "../storage/index.ts";
import type { MailboxDrain } from "../subagents/mailbox.ts";
import type { Event, StopReason } from "./events.ts";
import { dropGhostWaitNudge } from "./ghostWait.ts";
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
    readonly modeOverride?: string;
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
        mode:
            (input.modeOverride as SessionState["mode"]) ??
            input.config.permissions?.defaultMode ??
            "NORMAL",
        contextWindow,
        history: [],
        sessionRules: [],
        denialTrail: null,
        compactedThisTurn: false,
        headless: false,
        shapingFlags: newShapingFlags(),
        globalTurnIndex: 0,
        selectedMemory: null,
        turnState: newTurnState(),
        ghostWaitFiredThisPrompt: false,
        ghostWaitSuppressNext: false,
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
    // UI-driven steering for a background subagent. Drained at a turn boundary
    // only — never mid-turn, which would splice a user message between an
    // assistant tool call and its result.
    readonly mailbox?: MailboxDrain;
}

// Drives turns until a terminal stop reason fires. Yields all turn events
// to the caller.
export async function* queryLoop(input: QueryLoopInput): AsyncGenerator<Event> {
    const userMessage: Message = { role: "user", content: input.userPrompt };
    input.state.history.push(userMessage);
    input.state.ghostWaitFiredThisPrompt = false;
    input.state.ghostWaitSuppressNext = false;
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
        // Drained here, at the top, rather than after the turn that observed it:
        // a message pushed into history is only "delivered" once a turn actually
        // reads it, and only this position guarantees one follows.
        for (const steer of input.mailbox?.drain() ?? []) {
            input.state.history.push({ role: "user", content: steer.text });
            await input.session.appendEvent({ type: "user.message", content: steer.text });
        }

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

        const suppress = input.state.ghostWaitSuppressNext;
        input.state.ghostWaitSuppressNext = false;

        const buf: Event[] = [];
        // The reply to a ghost-wait nudge is held back, not discarded: a tool
        // call proves the turn is real work, and from that moment everything
        // held — the text before the call, the call, and the rest of the turn —
        // has to reach the UI live. Holding past the first tool call would also
        // deadlock outright, since permission.prompt carries the callback the
        // turn is blocked on.
        let holding = suppress;
        let stopReason: StopReason | undefined;
        while (true) {
            const next = await turn.next();
            if (next.done) {
                stopReason = next.value;
                break;
            }
            if (!holding) {
                yield next.value;
                continue;
            }
            buf.push(next.value);
            if (
                next.value.type === "model.toolCall" ||
                next.value.type === "model.toolCall.starting"
            ) {
                holding = false;
                for (const event of buf) yield event;
                buf.length = 0;
            }
        }

        if (holding) {
            const last = input.state.history[input.state.history.length - 1];
            const isTrivial =
                stopReason === "end_turn" &&
                last?.role === "assistant" &&
                !last.tool_calls?.length &&
                typeof last.content === "string";
            if (isTrivial) {
                input.state.history.pop();
                dropGhostWaitNudge(input.state.history);
            } else {
                for (const event of buf) yield event;
            }
        }

        if (stopReason !== "continue") {
            // A steer that landed while the chain was ending revives it, but the
            // turn ceiling still wins — it is the one budget nothing may raise.
            if (input.mailbox?.hasQueued() === true && turnIndex + 1 < maxTurns) {
                turnIndex += 1;
                continue;
            }
            break;
        }
        turnIndex += 1;
    }

    input.mailbox?.rejectQueued(
        `not delivered — the subagent stopped at its ceiling of ${maxTurns} turns`,
    );
}
