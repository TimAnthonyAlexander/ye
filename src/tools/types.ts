import type { Config } from "../config/index.ts";
import type { Provider, ToolDefinition } from "../providers/index.ts";

export type ToolResult<T = unknown> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: string };

export interface TodoItem {
    readonly id: string;
    readonly content: string;
    readonly status: "pending" | "in_progress" | "completed";
}

// Per-file fingerprint captured on Read. Edit/Write compare the live file
// against this to detect drift (formatter ran, another process wrote, etc.).
export interface ReadEntry {
    readonly hash: string;
}

// Turn-local mutable state shared with tools. The pipeline owns this object
// and resets it each turn. Tools mutate via the field, not by reassigning.
export interface TurnState {
    readFiles: Map<string, ReadEntry>;
    todos: TodoItem[];
}

// Tools that spawn subagents (currently: Task) need access to the parent's
// provider, config, project info, and session id. Set by the pipeline only on
// the parent's tool calls — subagents see this as undefined (recursion guard).
export interface SubagentToolContext {
    readonly projectId: string;
    readonly projectRoot: string;
    readonly parentSessionId: string;
    readonly contextWindow: number;
    readonly provider: Provider;
    readonly config: Config;
}

export interface ToolContext {
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly sessionId: string;
    readonly projectId: string;
    readonly turnState: TurnState;
    readonly subagentContext?: SubagentToolContext;
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
