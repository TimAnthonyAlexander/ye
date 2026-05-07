import { FALLBACK_CONTEXT_WINDOW, type Config } from "../config/index.ts";
import type { Message, Provider } from "../providers/index.ts";
import { openSession, type SessionHandle } from "../storage/index.ts";
import type { Event, StopReason } from "./events.ts";
import type { SessionState } from "./state.ts";
import { runTurn } from "./turn.ts";

export type { Event, StopReason } from "./events.ts";
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
}

// Drives turns until a terminal stop reason fires. Yields all turn events
// to the caller.
export async function* queryLoop(input: QueryLoopInput): AsyncGenerator<Event> {
  const userMessage: Message = { role: "user", content: input.userPrompt };
  input.state.history.push(userMessage);
  await input.session.appendEvent({ type: "user.message", content: input.userPrompt });

  const maxTurns = input.config.maxTurns?.master ?? 100;
  const signal = input.signal ?? new AbortController().signal;

  let turnIndex = 0;
  while (turnIndex < maxTurns) {
    const turn = runTurn({
      provider: input.provider,
      config: input.config,
      session: input.session,
      state: input.state,
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
