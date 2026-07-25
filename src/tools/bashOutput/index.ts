import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import { formatBashResult, getBackgroundManager } from "../bash/background.ts";

interface BashOutputArgs {
    readonly bash_id: string;
}

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<BashOutputArgs>(rawArgs, BashOutputTool.schema);
    if (!v.ok) return v;

    const mgr = getBackgroundManager(ctx.sessionId);
    const task = mgr.poll(v.value.bash_id);
    if (!task) {
        return { ok: false, error: `no background task with id "${v.value.bash_id}"` };
    }

    const durationMs = Date.now() - task.startedAt;

    if (task.status === "running") {
        // Nothing captured yet means this peek was a completion check, not a
        // read of partial output — refuse it rather than confirming the habit.
        if (task.stdout.length === 0 && task.stderr.length === 0) {
            return {
                ok: false,
                error:
                    `${task.id} is still running and has produced no output yet, so there is nothing to read. ` +
                    `Its full output is delivered to you automatically in a <system-reminder> when it finishes, even if you have ended your turn and gone idle. ` +
                    `END YOUR TURN and wait to be woken rather than checking again.`,
            };
        }
        return {
            ok: true,
            value:
                `[${task.id} still running, ${durationMs}ms elapsed — partial output below. ` +
                `The full result arrives automatically when it finishes; do not call BashOutput again just to see whether it is done.]\n${task.stdout}` +
                (task.stderr ? `\n<stderr>\n${task.stderr}\n</stderr>` : ""),
        };
    }

    return {
        ok: true,
        value: formatBashResult(task.stdout, task.stderr, task.exitCode ?? 1, durationMs),
    };
};

export const BashOutputTool: Tool = {
    name: "BashOutput",
    description:
        "Read a background bash task's partial output while it runs. Use it ONLY when you need that partial output to decide " +
        "something you cannot defer (e.g. early build logs) — NOT to check whether the task is done, which is never something " +
        "you need to do: the full output is delivered to you automatically in a system-reminder when the task finishes, even " +
        "while you are idle. Calling it on a task that has produced no output yet returns an error.",
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        required: ["bash_id"],
        properties: {
            bash_id: { type: "string" },
        },
    },
    execute,
};
