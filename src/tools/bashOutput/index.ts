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
        return {
            ok: true,
            value:
                `[still running, ${durationMs}ms elapsed]\n${task.stdout}` +
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
        "Poll a background bash task for its current output and status. " +
        "Returns the stdout/stderr captured so far (still running) or the final result (completed/failed/killed). " +
        "Use this to check on a task you started with Bash's `run_in_background: true`.",
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
