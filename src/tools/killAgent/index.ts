import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import { getBackgroundSubagentManager } from "../../subagents/background.ts";

interface KillAgentArgs {
    readonly task_id: string;
}

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<KillAgentArgs>(rawArgs, KillAgentTool.schema);
    if (!v.ok) return v;

    const mgr = getBackgroundSubagentManager(ctx.sessionId);
    const killed = mgr.kill(v.value.task_id);
    if (!killed) {
        return { ok: false, error: `no running background subagent with id "${v.value.task_id}"` };
    }

    return {
        ok: true,
        value: `Killed background subagent ${v.value.task_id}.`,
    };
};

export const KillAgentTool: Tool = {
    name: "KillAgent",
    description:
        "Stop a running background subagent. Use this to kill a subagent you started with Task's " +
        "`run_in_background: true` before it completes on its own. Has no effect on already-completed tasks.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["task_id"],
        properties: {
            task_id: { type: "string" },
        },
    },
    execute,
};
