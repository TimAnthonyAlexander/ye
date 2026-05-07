import type { ExploreThoroughness, SubagentKind } from "../../subagents/index.ts";
import { isSubagentKind, spawn, SubagentError } from "../../subagents/index.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface TaskArgs {
    readonly kind: SubagentKind;
    readonly prompt: string;
    readonly thoroughness?: ExploreThoroughness;
}

interface TaskResultValue {
    readonly summary: string;
    readonly transcriptPath: string;
    readonly turnCount: number;
}

const isThoroughness = (v: unknown): v is ExploreThoroughness =>
    v === "quick" || v === "medium" || v === "very_thorough";

const execute = async (
    rawArgs: unknown,
    ctx: ToolContext,
): Promise<ToolResult<TaskResultValue>> => {
    const v = validateArgs<TaskArgs>(rawArgs, TaskTool.schema);
    if (!v.ok) return v;

    const { kind, prompt } = v.value;
    if (!isSubagentKind(kind)) {
        return { ok: false, error: `unknown subagent kind: ${String(kind)}` };
    }

    const thoroughness = v.value.thoroughness;
    if (thoroughness !== undefined && !isThoroughness(thoroughness)) {
        return {
            ok: false,
            error: `thoroughness must be "quick" | "medium" | "very_thorough"`,
        };
    }

    const subagentCtx = ctx.subagentContext;
    if (!subagentCtx) {
        return {
            ok: false,
            error: "Task tool is not available in this context (recursion guard).",
        };
    }

    try {
        const result = await spawn(
            {
                kind,
                prompt,
                ...(thoroughness ? { options: { thoroughness } } : {}),
            },
            {
                parentProjectId: subagentCtx.projectId,
                parentProjectRoot: subagentCtx.projectRoot,
                parentSessionId: subagentCtx.parentSessionId,
                contextWindow: subagentCtx.contextWindow,
                config: subagentCtx.config,
                provider: subagentCtx.provider,
                signal: ctx.signal,
            },
        );
        return {
            ok: true,
            value: {
                summary: result.summary,
                transcriptPath: result.transcriptPath,
                turnCount: result.turnCount,
            },
        };
    } catch (e) {
        if (e instanceof SubagentError) {
            return { ok: false, error: e.message };
        }
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
};

export const TaskTool: Tool = {
    name: "Task",
    description:
        "Spawn an isolated subagent to investigate or perform a task in a fresh context. " +
        "kind=\"explore\" uses Read/Glob/Grep only and returns a summary " +
        "(thoroughness: quick|medium|very_thorough). kind=\"general\" gets the full toolset " +
        "and runs in AUTO mode. The subagent's transcript is preserved separately; only " +
        "its final assistant message is returned to you. Use a subagent when the task " +
        "would otherwise pollute your context with many tool calls.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["kind", "prompt"],
        properties: {
            kind: { type: "string", enum: ["explore", "general"] },
            prompt: { type: "string" },
            thoroughness: {
                type: "string",
                enum: ["quick", "medium", "very_thorough"],
            },
        },
    },
    execute,
};
