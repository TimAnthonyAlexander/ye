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

    // A running subagent exposes no partial progress, so this call can only ever
    // return "still running" — zero information. Returning ok:true taught the
    // model that polling was a legitimate move and it looped once per second, so
    // the peek is refused outright and the reply says what to do instead.
    if (task.status === "running") {
        return {
            ok: false,
            error:
                `${task.id} is still running, and a running subagent has no partial output to read — this call can never tell you anything. ` +
                `Its summary is delivered to you automatically in a <system-reminder> the moment it finishes, even if you have ended your turn and gone idle. ` +
                `END YOUR TURN and wait to be woken. Do not call TaskOutput on ${task.id} again; use KillAgent if you no longer want its result.`,
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
        "Re-fetch the final summary of a background subagent that has ALREADY finished — use it only when you know it " +
        "completed and its summary is no longer in your context. This is NOT a progress or status check: calling it on a " +
        "still-running subagent returns an ERROR and no information, because a running subagent has no partial output. " +
        "You never need it to learn that a subagent finished — the summary is delivered to you automatically in a " +
        "system-reminder when it does, even while you are idle.",
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
