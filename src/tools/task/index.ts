import type { Event } from "../../pipeline/events.ts";
import type { ExploreThoroughness, SubagentKind, SubagentSpec } from "../../subagents/index.ts";
import { isSubagentKind, spawn, SubagentError } from "../../subagents/index.ts";
import { getBackgroundSubagentManager } from "../../subagents/background.ts";
import { formatChildLine } from "../../subagents/formatLine.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface TaskArgs {
    readonly kind: SubagentKind;
    readonly prompt: string;
    readonly thoroughness?: ExploreThoroughness;
    readonly run_in_background?: boolean;
}

interface TaskResultValue {
    readonly summary: string;
    readonly transcriptPath: string;
    readonly turnCount: number;
}

const isThoroughness = (v: unknown): v is ExploreThoroughness =>
    v === "quick" || v === "medium" || v === "very_thorough";

const PROGRESS_TAIL = 5;

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

    // Background is the default. The model opts into a blocking foreground run
    // only by passing run_in_background: false (when it needs the result before
    // its next action). Resolved after the recursion guard above, which already
    // rejects any Task call inside a subagent — so nesting can't reach here.
    const runInBackground = v.value.run_in_background ?? true;

    if (runInBackground) {
        const spec: SubagentSpec = {
            kind,
            prompt,
            ...(thoroughness ? { options: { thoroughness } } : {}),
        };
        const spawnCtx = {
            parentProjectId: subagentCtx.projectId,
            parentProjectRoot: subagentCtx.projectRoot,
            parentSessionId: subagentCtx.parentSessionId,
            contextWindow: subagentCtx.contextWindow,
            config: subagentCtx.config,
            provider: subagentCtx.provider,
            signal: ctx.signal,
        };
        const mgr = getBackgroundSubagentManager(ctx.sessionId);
        const id = mgr.start(spec, spawnCtx);
        // This string is the last instruction the model reads before deciding
        // what to do next, so it must state the wait — an earlier version said
        // "use TaskOutput to check status" and the model dutifully polled every
        // second instead of ending its turn.
        return {
            ok: true,
            value: {
                summary:
                    `Background subagent started: ${id}\nKind: ${kind}\nPrompt: ${prompt}\n` +
                    `${id} is now running on its own. There is nothing to check and nothing to wait for in this turn: ` +
                    `its summary is delivered to you automatically in a <system-reminder> the moment it finishes, even if you have ended your turn and gone idle. ` +
                    `If you have no other work to do right now, END YOUR TURN — you will be woken. ` +
                    `Do NOT call TaskOutput on ${id}; while it runs TaskOutput returns an error and no information. ` +
                    `KillAgent stops it if you no longer want its result.`,
                transcriptPath: "",
                turnCount: 0,
            },
        };
    }

    const recent: string[] = [];
    const onChildEvent = (evt: Event): void => {
        const line = formatChildLine(evt, ctx.cwd);
        if (line === null) return;
        recent.push(line);
        if (recent.length > PROGRESS_TAIL) recent.shift();
        ctx.emitProgress?.([...recent]);
    };

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
                onChildEvent,
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
        'kind="explore" uses Read/Glob/Grep only and returns a summary ' +
        '(thoroughness: quick|medium|very_thorough). kind="general" gets the full toolset ' +
        'and runs in AUTO mode. kind="verification" uses Read/Glob/Grep/Bash to run ' +
        "typecheck + tests + git diff and returns failures — use after implementing a plan. " +
        "The subagent's transcript is preserved separately; only " +
        "its final assistant message is returned to you. Use a subagent when the task " +
        "would otherwise pollute your context with many tool calls. " +
        "By DEFAULT the subagent runs in the BACKGROUND: Task returns immediately with a " +
        "task ID and its summary is delivered to you automatically in a system-reminder when it " +
        "finishes, even while you are idle. So fire one or several, then either do unrelated work " +
        "or end your turn — ending your turn is how you wait, and a running subagent cannot be " +
        "inspected (TaskOutput errors until it finishes). Pass run_in_background: false " +
        "ONLY when you need the subagent's result before your next action — it then blocks " +
        "and streams progress until done.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["kind", "prompt"],
        properties: {
            kind: { type: "string", enum: ["explore", "general", "verification"] },
            prompt: { type: "string" },
            thoroughness: {
                type: "string",
                enum: ["quick", "medium", "very_thorough"],
            },
            run_in_background: {
                type: "boolean",
                description:
                    "Defaults to true (background/async). Set false to block in the foreground until the subagent finishes, when you need its result before your next action.",
            },
        },
    },
    execute,
};
