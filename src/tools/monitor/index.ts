import { getMonitorManager, type MonitorSpec } from "../../monitors/index.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface MonitorArgs {
    readonly reason: string;
    readonly condition?: string;
    readonly capture?: string;
    readonly at?: string;
    readonly intervalSec?: number;
    readonly giveUpAfterSec?: number;
}

// A `-p` run ends when the work ends, so a monitor whose deadline outlives it
// would hold the process open for as long as that deadline.
const HEADLESS_GIVE_UP_CAP_SEC = 3600;

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<MonitorArgs>(rawArgs, MonitorTool.schema);
    if (!v.ok) return v;

    const args = v.value;
    const clamped =
        ctx.headless &&
        (args.giveUpAfterSec === undefined || args.giveUpAfterSec > HEADLESS_GIVE_UP_CAP_SEC);
    const giveUpAfterSec = clamped ? HEADLESS_GIVE_UP_CAP_SEC : args.giveUpAfterSec;

    const spec: MonitorSpec = {
        reason: args.reason,
        ...(args.condition !== undefined ? { condition: args.condition } : {}),
        ...(args.capture !== undefined ? { capture: args.capture } : {}),
        ...(args.at !== undefined ? { at: args.at } : {}),
        ...(args.intervalSec !== undefined ? { intervalSec: args.intervalSec } : {}),
        ...(giveUpAfterSec !== undefined ? { giveUpAfterSec } : {}),
    };

    let id: string;
    try {
        id = getMonitorManager(ctx.sessionId).start(spec, ctx.cwd);
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const watching =
        args.condition !== undefined && args.at !== undefined
            ? `Waiting for \`${args.condition}\` to succeed, or for ${args.at}, whichever comes first.`
            : args.condition !== undefined
              ? `Waiting for \`${args.condition}\` to succeed.`
              : `Waiting until ${args.at}.`;

    // This string is the last thing the model reads before choosing its next
    // action, so it has to state the wait as flatly as Task's does — anything
    // softer and the model polls the condition itself instead of ending.
    const lines = [
        `Monitor started: ${id}`,
        `Reason: ${args.reason}`,
        watching,
        `${id} is now running on its own. There is nothing to check and nothing to wait for in this turn: ` +
            `its outcome and captured output are delivered to you automatically in a <system-reminder> the moment it finishes, ` +
            `even if you have ended your turn and gone idle. ` +
            `If you have no other work to do right now, END YOUR TURN — you will be woken. ` +
            `Do NOT run the condition yourself to see where it is at, and do NOT start a second monitor for the same thing. ` +
            `KillMonitor stops ${id} if you no longer want its result.`,
    ];
    if (clamped) {
        lines.push(
            `This is a headless (-p) run, so giveUpAfterSec was clamped to ${HEADLESS_GIVE_UP_CAP_SEC}s — ` +
                `${id} will give up after an hour at the latest.`,
        );
    }

    return { ok: true, value: lines.join("\n") };
};

export const MonitorTool: Tool = {
    name: "Monitor",
    description:
        "Watch for something to happen in the background and get told when it does. " +
        "Give a `condition` shell command, an `at` time, or both; you need at least one. " +
        "The condition is polled on an interval until it exits 0 (true) — exit 1 means not yet, any " +
        "other exit is an error, and three errors in a row stop the monitor. `at` is an ISO 8601 " +
        "timestamp or HH:MM (the next occurrence of that clock time). `capture` is a second command " +
        "run once the monitor fires, whose stdout is returned to you — use it to grab the log tail or " +
        "status you actually want to read. " +
        "The condition command runs unattended and repeatedly for as long as the monitor lives, so it " +
        "MUST be cheap and free of side effects: a check, never an action. Approving this monitor " +
        "approves every future poll of that command, without a further prompt. " +
        "Monitor returns immediately with an id and the result arrives on its own in a " +
        "<system-reminder>, so start it and then end your turn rather than waiting.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["reason"],
        properties: {
            reason: {
                type: "string",
                description:
                    "Short phrase for what is being waited on, shown to the user and quoted back when the monitor fires.",
            },
            condition: {
                type: "string",
                description:
                    "Shell command polled until it exits 0. Must be cheap and side-effect free.",
            },
            capture: {
                type: "string",
                description:
                    "Shell command run once when the monitor fires; its stdout is returned to you.",
            },
            at: {
                type: "string",
                description: "ISO 8601 timestamp, or HH:MM for the next occurrence of that time.",
            },
            intervalSec: {
                type: "number",
                description: "Seconds between polls. Defaults to 30, floored at 5.",
            },
            giveUpAfterSec: {
                type: "number",
                description:
                    "Stop and report if the condition never became true within this many seconds. Defaults to 24h.",
            },
        },
    },
    execute,
};
