import type { TodoItem, Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface TodoWriteArgs {
    readonly todos: ReadonlyArray<{
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

    // Naming the offenders and the repair: the whole list is rejected, so a
    // model that only knows "one may be in_progress" has to guess which of its
    // own items to demote and resend everything.
    const inProgress = v.value.todos.filter((t) => t.status === "in_progress");
    if (inProgress.length > 1) {
        const names = inProgress.map((t) => `"${t.content.slice(0, 40)}"`).join(", ");
        return {
            ok: false,
            error:
                `exactly one todo can be in_progress at a time; ${inProgress.length} are: ${names}. ` +
                "Leave the one you are working on now as in_progress, set the others to pending " +
                "or completed, and send the whole list again.",
        };
    }

    ctx.turnState.todos = v.value.todos.map<TodoItem>((t) => ({
        content: t.content,
        status: t.status,
    }));
    return { ok: true, value: { count: ctx.turnState.todos.length } };
};

export const TodoWriteTool: Tool = {
    name: "TodoWrite",
    description:
        "Replace the current todo list. Each todo has content and status (pending/in_progress/completed). " +
        "At most one todo may be in_progress at a time.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["todos"],
        properties: {
            todos: {
                type: "array",
                items: {
                    type: "object",
                    required: ["content", "status"],
                    properties: {
                        content: { type: "string" },
                        status: {
                            type: "string",
                            enum: ["pending", "in_progress", "completed"],
                        },
                    },
                },
            },
        },
    },
    execute,
};
