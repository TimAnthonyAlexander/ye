import type { ToolDefinition } from "../providers/index.ts";

export type ToolResult<T = unknown> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: string };

export interface TodoItem {
    readonly id: string;
    readonly content: string;
    readonly status: "pending" | "in_progress" | "completed";
}

// Turn-local mutable state shared with tools. The pipeline owns this object
// and resets it each turn. Tools mutate via the field, not by reassigning.
export interface TurnState {
    readFiles: Set<string>;
    todos: TodoItem[];
}

export interface ToolContext {
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly sessionId: string;
    readonly projectId: string;
    readonly turnState: TurnState;
    log(msg: string): void;
}

export interface ToolAnnotations {
    readonly readOnlyHint?: boolean;
    readonly destructive?: boolean;
}

export interface Tool<Args = unknown, Out = unknown> {
    readonly name: string;
    readonly description: string;
    readonly schema: object;
    readonly annotations: ToolAnnotations;
    execute(args: Args, ctx: ToolContext): Promise<ToolResult<Out>>;
}

export const toToolDefinition = (tool: Tool): ToolDefinition => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.schema,
});
