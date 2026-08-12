import type { PermissionMode, PermissionRule } from "../config/index.ts";
import type { Message } from "../providers/index.ts";
import type { TurnState } from "../tools/index.ts";

export interface DenialTrail {
    readonly tool: string;
    readonly count: number;
}

// Structurally compatible with MemoryFile from src/memory/select.ts.
// Defined here (not imported) to avoid a select.ts → pipeline → select.ts cycle.
export interface SelectedMemoryEntry {
    readonly path: string;
    readonly title: string;
    readonly content: string;
}

// One-shot per-turn flags for each shaper that mutates state.history. Set on
// "applied", reset at turn start. Generalizes the original compactedThisTurn
// flag (which is dual-written by autoCompact for one release).
export interface ShapingFlags {
    snip: boolean;
    microcompact: boolean;
    contextCollapse: boolean;
    autoCompact: boolean;
}

export interface SessionState {
    readonly sessionId: string;
    readonly projectId: string;
    readonly projectRoot: string;
    mode: PermissionMode;
    contextWindow: number;
    history: Message[];
    sessionRules: PermissionRule[];
    denialTrail: DenialTrail | null;
    compactedThisTurn: boolean;
    // Set the moment a plan is approved (ExitPlanMode flips PLAN → NORMAL). Read
    // at the next turn's stop check: if that turn is text-only, the model is
    // stalling ("ready when you are") instead of executing the just-approved
    // plan — nudge it to start and keep looping. Cleared after that one turn so
    // the nudge fires at most once. Optional: only the interactive loop enters
    // PLAN mode, so subagent/headless states leave it undefined.
    planJustAccepted?: boolean;
    shapingFlags: ShapingFlags;
    // Session-monotonic turn counter, incremented at the top of every runTurn.
    // Distinct from queryLoop's per-prompt turnIndex (which resets each user
    // message). Used as the checkpoint id for state-modifying tools so file
    // snapshots from different user prompts don't collide.
    globalTurnIndex: number;
    // Per-session model override. When undefined, runTurn falls back to
    // config.defaultModel.model. /model and /provider mutate this; provider
    // switches also clear it (the new provider gets its registry default).
    activeModel?: string;
    // Sticky routing state, keyed by model id. When config.defaultModel.routing
    // is "sticky", turn.ts captures the upstream provider from the first usage
    // event for a given model and pins subsequent requests for that model to
    // the same upstream. /model and /provider switches clear this entirely.
    pinnedUpstream?: Readonly<Record<string, string>>;
    // Auto-memory cache: populated lazily on first turn that has a user query.
    // null = not yet selected; [] = no memory available; non-empty = active.
    selectedMemory: readonly SelectedMemoryEntry[] | null;
    // Persistent across user prompts within a session: Read/Edit/Write hash
    // tracking and TodoWrite list. Confusingly named "turnState" for backwards
    // compatibility with how tools consume it via ToolContext, but the lifetime
    // is the whole session — Edit-after-prior-prompt-Read works as long as the
    // file hasn't drifted on disk. Edit/Write re-hash the file before writing
    // to catch external modification.
    turnState: TurnState;
    // Subagent fields. Set only when this state belongs to a subagent run.
    // The pipeline reads them to narrow the tool pool and override the system prompt.
    headless: boolean;
    parentSessionId?: string;
    allowedTools?: readonly string[];
    systemPromptOverride?: string;
    // Git status injection: hash of the last injected status output. When the new
    // output hashes to the same value, a short "nothing changed" note is injected
    // instead of repeating the full status. undefined = not yet injected.
    lastGitStatusHash?: string;
    // Set when the ghost-wait nudge fires in a prompt's chain. Cleared at the
    // start of each new queryLoop so it fires at most once per user message,
    // across verify continuations and its own re-triggers.
    ghostWaitFiredThisPrompt: boolean;
    // When the nudge fired this prompt, queryLoop sets this to buffer the very
    // next turn's events. After that turn completes, if it was a trivial ack
    // the events are suppressed and the user sees nothing. Cleared at the
    // start of each new queryLoop.
    ghostWaitSuppressNext: boolean;
}

export const newTurnState = (): TurnState => ({
    readFiles: new Map(),
    todos: [],
});

export const newShapingFlags = (): ShapingFlags => ({
    snip: false,
    microcompact: false,
    contextCollapse: false,
    autoCompact: false,
});

export const resetShapingFlags = (state: SessionState): void => {
    state.shapingFlags.snip = false;
    state.shapingFlags.microcompact = false;
    state.shapingFlags.contextCollapse = false;
    state.shapingFlags.autoCompact = false;
};

export const resetDenialTrail = (state: SessionState): void => {
    state.denialTrail = null;
};

export const recordDenial = (state: SessionState, tool: string): void => {
    if (state.denialTrail && state.denialTrail.tool === tool) {
        state.denialTrail = { tool, count: state.denialTrail.count + 1 };
    } else {
        state.denialTrail = { tool, count: 1 };
    }
};
