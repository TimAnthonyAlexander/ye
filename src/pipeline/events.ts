import type { PermissionPromptPayload, PromptResponse } from "../permissions/index.ts";
import type { ToolResult, UserQuestionOption } from "../tools/index.ts";

export interface UserQuestionPayload {
    readonly question: string;
    readonly options: readonly UserQuestionOption[];
    readonly multiSelect: boolean;
}

export type StopReason =
    | "end_turn"
    | "max_turns"
    | "context_overflow"
    | "plan_loop_guard"
    | "user_cancel"
    | "error"
    | "continue"; // non-terminal turn boundary; queryLoop runs another turn

export type Event =
    | { readonly type: "turn.start"; readonly turnIndex: number }
    | { readonly type: "model.text"; readonly delta: string }
    | { readonly type: "model.reasoning"; readonly delta: string }
    | {
          readonly type: "model.toolCall";
          readonly id: string;
          readonly name: string;
          readonly args: unknown;
      }
    | {
          readonly type: "permission.prompt";
          readonly payload: PermissionPromptPayload;
          respond(decision: PromptResponse): void;
      }
    | {
          readonly type: "tool.start";
          readonly id: string;
          readonly name: string;
          readonly args: unknown;
      }
    | {
          readonly type: "tool.end";
          readonly id: string;
          readonly name: string;
          readonly result: ToolResult;
      }
    | {
          readonly type: "tool.progress";
          readonly id: string;
          readonly lines: readonly string[];
      }
    | { readonly type: "mode.changed"; readonly mode: string }
    | {
          readonly type: "userQuestion.prompt";
          readonly id: string;
          readonly payload: UserQuestionPayload;
          respond(answer: string): void;
      }
    | { readonly type: "turn.end"; readonly stopReason: StopReason; readonly error?: string };

// A subset of Event that's safe to persist to the JSONL transcript (no callbacks).
export interface TranscriptEvent {
    readonly type: string;
    readonly [key: string]: unknown;
}

export const transcriptable = (event: Event): TranscriptEvent => {
    if (event.type === "permission.prompt") {
        return { type: event.type, payload: event.payload };
    }
    if (event.type === "userQuestion.prompt") {
        return { type: event.type, id: event.id, payload: event.payload };
    }
    return event as unknown as TranscriptEvent;
};
