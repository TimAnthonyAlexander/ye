import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import { getBackgroundSubagentManager } from "../../subagents/background.ts";

interface TaskOutputArgs {
    readonly task_id: string;
}

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<TaskOutputArgs>(rawArgs, TaskOutputTool.schema);
    if (!v.ok) return v;

    const mgr = getBackgroundSubagentManager(ctx.sessionId);
    const task = mgr.poll(v.value.task_id);
    if (!task) {
        return { ok: false, error: `no background subagent with id "${v.value.task_id}"` };
    }

    const durationMs = Date.now() - task.startedAt;

    if (task.status === "running") {
        return {
            ok: true,
            value: `[still running, ${durationMs}ms elapsed]`,
        };
    }

    if (task.status === "killed") {
        return {
            ok: true,
            value: `[killed, ${durationMs}ms elapsed]`,
        };
    }

    if (task.status === "failed") {
        return {
            ok: true,
            value: `[failed, ${durationMs}ms elapsed]\n${task.error || "unknown error"}`,
        };
    }

    return {
        ok: true,
        value: task.summary,
    };
};

export const TaskOutputTool: Tool = {
    name: "TaskOutput",
    description:
        "Poll a background subagent for its current status and result. " +
        "Use this to check on a subagent you started with Task's `run_in_background: true`. " +
        "Returns status if still running, or the final summary if complete.",
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        required: ["task_id"],
        properties: {
            task_id: { type: "string" },
        },
    },
    execute,
};
