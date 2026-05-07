import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getProjectPlansDir, randomPlanName } from "../../storage/index.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface ExitPlanModeArgs {
    readonly plan: string;
}

// Pipeline-recognized result shape. When the pipeline sees `kind === "request_mode_flip"`
// in a tool result, it fires a separate permission prompt with reason "exit_plan_mode"
// instead of routing through the regular gate.
export interface RequestModeFlipResult {
    readonly kind: "request_mode_flip";
    readonly planPath: string;
    readonly target: "NORMAL";
}

const execute = async (
    rawArgs: unknown,
    ctx: ToolContext,
): Promise<ToolResult<RequestModeFlipResult>> => {
    const v = validateArgs<ExitPlanModeArgs>(rawArgs, ExitPlanModeTool.schema);
    if (!v.ok) return v;

    const dir = getProjectPlansDir(ctx.projectId);
    await mkdir(dir, { recursive: true });
    const filename = `${randomPlanName()}.md`;
    const planPath = join(dir, filename);
    await Bun.write(planPath, v.value.plan.endsWith("\n") ? v.value.plan : `${v.value.plan}\n`);

    return {
        ok: true,
        value: { kind: "request_mode_flip", planPath, target: "NORMAL" },
    };
};

export const ExitPlanModeTool: Tool = {
    name: "ExitPlanMode",
    description:
        "Submit a proposed plan and request a flip out of PLAN mode. Writes the plan to a " +
        "persistent file and triggers a permission prompt asking the user to accept the plan " +
        "and switch to NORMAL mode. The only state-modifying tool allowed in PLAN mode.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["plan"],
        properties: {
            plan: { type: "string" },
        },
    },
    execute,
};

// Type-narrowing helper for the pipeline.
export const isRequestModeFlip = (value: unknown): value is RequestModeFlipResult =>
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "request_mode_flip";
