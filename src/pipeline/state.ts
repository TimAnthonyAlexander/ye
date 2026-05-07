import type { PermissionMode, PermissionRule } from "../config/index.ts";
import type { Message } from "../providers/index.ts";
import type { TurnState } from "../tools/index.ts";

export interface DenialTrail {
  readonly tool: string;
  readonly count: number;
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
}

export const newTurnState = (): TurnState => ({
  readFiles: new Set<string>(),
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
