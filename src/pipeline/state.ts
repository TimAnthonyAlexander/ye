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
    // Per-session model override. When undefined, runTurn falls back to
    // config.defaultModel.model. /model and /provider mutate this; provider
    // switches also clear it (the new provider gets its registry default).
    activeModel?: string;
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
    parentSessionId?: string;
    allowedTools?: readonly string[];
    systemPromptOverride?: string;
}

export const newTurnState = (): TurnState => ({
    readFiles: new Map(),
    todos: [],
});

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
