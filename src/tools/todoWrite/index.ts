import type { TodoItem, Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface TodoWriteArgs {
  readonly todos: ReadonlyArray<{
    readonly id: string;
    readonly content: string;
    readonly status: "pending" | "in_progress" | "completed";
  }>;
}

const execute = async (
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResult<{ count: number }>> => {
  const v = validateArgs<TodoWriteArgs>(rawArgs, TodoWriteTool.schema);
  if (!v.ok) return v;

  const inProgress = v.value.todos.filter((t) => t.status === "in_progress").length;
  if (inProgress > 1) {
    return { ok: false, error: "exactly one todo can be in_progress at a time" };
  }

  ctx.turnState.todos = v.value.todos.map<TodoItem>((t) => ({
    id: t.id,
    content: t.content,
    status: t.status,
  }));
  return { ok: true, value: { count: ctx.turnState.todos.length } };
};

export const TodoWriteTool: Tool = {
  name: "TodoWrite",
  description:
    "Replace the current todo list. Each todo has id, content, and status (pending/in_progress/completed). " +
    "At most one todo may be in_progress at a time.",
  annotations: { readOnlyHint: false },
  schema: {
    type: "object",
    required: ["todos"],
    properties: {
      todos: { type: "array" },
    },
  },
  execute,
};
