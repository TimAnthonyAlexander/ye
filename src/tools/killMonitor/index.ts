import { getMonitorManager } from "../../monitors/index.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface KillMonitorArgs {
    readonly monitor_id: string;
}

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<KillMonitorArgs>(rawArgs, KillMonitorTool.schema);
    if (!v.ok) return v;

    const { monitor_id } = v.value;
    const mgr = getMonitorManager(ctx.sessionId);
    if (mgr.kill(monitor_id)) {
        return { ok: true, value: `Killed monitor ${monitor_id}. It will not report back.` };
    }

    const running = mgr
        .list()
        .filter((m) => m.status === "running")
        .map((m) => `${m.id} (${m.reason})`);
    return {
        ok: false,
        error:
            `No running monitor with id "${monitor_id}". ` +
            (running.length > 0
                ? `Running monitors: ${running.join(", ")}.`
                : "No monitors are running."),
    };
};

export const KillMonitorTool: Tool = {
    name: "KillMonitor",
    description:
        "Stop a running monitor started with the Monitor tool, before it fires on its own. " +
        "Use it when you no longer need what the monitor was waiting for. A monitor that has " +
        "already finished cannot be killed and reports its outcome regardless.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["monitor_id"],
        properties: {
            monitor_id: { type: "string" },
        },
    },
    execute,
};
