import type { Tool, ToolContext, ToolResult } from "../types.ts";
import type { RequestModeFlipResult } from "../exitPlanMode/index.ts";
import { validateArgs } from "../validate.ts";

interface EnterPlanModeArgs {
    readonly reason: string;
}

const execute = async (
    rawArgs: unknown,
    _ctx: ToolContext,
): Promise<ToolResult<RequestModeFlipResult>> => {
    const v = validateArgs<EnterPlanModeArgs>(rawArgs, EnterPlanModeTool.schema);
    if (!v.ok) return v;

    return {
        ok: true,
        value: { kind: "request_mode_flip", target: "PLAN" },
    };
};

export const EnterPlanModeTool: Tool = {
    name: "EnterPlanMode",
    description:
        "Request a switch INTO PLAN mode. Use when you want to read-and-think before " +
        "making changes. Triggers a permission prompt asking the user to approve the " +
        "switch from the current mode to PLAN. The reason argument should briefly explain " +
        "why you want to plan first. No-op when already in PLAN.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["reason"],
        properties: {
            reason: { type: "string" },
        },
    },
    execute,
};
