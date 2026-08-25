import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import { getBackgroundManager } from "../bash/background.ts";

interface KillShellArgs {
    readonly bash_id: string;
}

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<KillShellArgs>(rawArgs, KillShellTool.schema);
    if (!v.ok) return v;

    const id = v.value.bash_id;
    const mgr = getBackgroundManager(ctx.sessionId);
    const task = mgr.poll(id);
    if (!task) {
        return { ok: false, error: `no background task with id "${id}" in this session` };
    }
    // A task that finished between the model reading its output and killing it
    // is the ordinary race, and the tool's contract is "no effect on completed
    // tasks". Reporting that as a failure sends the model looking for a bug
    // that isn't there; naming the status it found ends it in one line.
    if (task.status !== "running") {
        return {
            ok: true,
            value: `Background task ${id} already ${task.status}; nothing to kill.`,
        };
    }

    mgr.kill(id);
    return { ok: true, value: `Killed background task ${id}.` };
};

export const KillShellTool: Tool = {
    name: "KillShell",
    description:
        "Stop a running background bash task. Use this to kill a task you started with Bash's `run_in_background: true` " +
        "before it completes on its own. Has no effect on already-completed tasks.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["bash_id"],
        properties: {
            bash_id: { type: "string" },
        },
    },
    execute,
};
