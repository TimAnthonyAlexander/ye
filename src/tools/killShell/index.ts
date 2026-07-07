import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import { getBackgroundManager } from "../bash/background.ts";

interface KillShellArgs {
    readonly bash_id: string;
}

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<KillShellArgs>(rawArgs, KillShellTool.schema);
    if (!v.ok) return v;

    const mgr = getBackgroundManager(ctx.sessionId);
    const killed = mgr.kill(v.value.bash_id);
    if (!killed) {
        return { ok: false, error: `no running background task with id "${v.value.bash_id}"` };
    }

    return {
        ok: true,
        value: `Killed background task ${v.value.bash_id}.`,
    };
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
