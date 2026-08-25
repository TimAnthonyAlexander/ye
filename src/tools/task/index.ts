import type { Event } from "../../pipeline/events.ts";
import type { ExploreThoroughness, SubagentKind, SubagentSpec } from "../../subagents/index.ts";
import {
    isKnownKind,
    listAgents,
    resolveKind,
    spawn,
    SubagentError,
    unknownKindError,
} from "../../subagents/index.ts";
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

const STATIC_DESCRIPTION =
    "Spawn a subagent to investigate or perform a task. Each agent type has its own tool " +
    "whitelist and turn budget, listed below; pick the one that matches the work. " +
    'kind="fork" is the exception to "fresh context": it inherits a copy of your current ' +
    "conversation, so use it when the task only makes sense with everything you already " +
    "know, and describe the task in the prompt anyway. " +
    "The subagent's transcript is preserved separately; only its final assistant message " +
    "is returned to you. Use a subagent when the task would otherwise pollute your context " +
    "with many tool calls. " +
    "By DEFAULT the subagent runs in the BACKGROUND: Task returns immediately with a " +
    "task ID and its summary is delivered to you automatically in a system-reminder when it " +
    "finishes, even while you are idle. So fire one or several, then either do unrelated work " +
    "or end your turn — ending your turn is how you wait, and a running subagent cannot be " +
    "inspected (TaskOutput errors until it finishes). Pass run_in_background: false " +
    "ONLY when you need the subagent's result before your next action — it then blocks " +
    "and streams progress until done. " +
    'For kind="explore", thoroughness (quick|medium|very_thorough) sets the turn budget.';

const buildDescription = (): string => {
    const lines = listAgents().map(
        (a) =>
            `- ${a.name} [${a.source}]: ${a.description} (tools: ${
                a.tools.length > 0 ? a.tools.join(", ") : "none"
            }; turns: ${a.turnsLabel})`,
    );
    return `${STATIC_DESCRIPTION}\n\n<available_agents>\n${lines.join("\n")}\n</available_agents>`;
};

// `kinds` is null for the validation pass: the catalogue is rooted at the
// parent's project, which execute knows and a schema getter does not, so the
// authoritative kind check happens there and reports the valid names itself.
const buildSchema = (kinds: readonly string[] | null): object => ({
    type: "object",
    required: ["kind", "prompt"],
    properties: {
        kind: kinds === null ? { type: "string" } : { type: "string", enum: kinds },
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
});

const execute = async (
    rawArgs: unknown,
    ctx: ToolContext,
): Promise<ToolResult<TaskResultValue>> => {
    const v = validateArgs<TaskArgs>(rawArgs, buildSchema(null));
    if (!v.ok) return v;

    const subagentCtx = ctx.subagentContext;
    if (!subagentCtx) {
        return {
            ok: false,
            error: "Task tool is not available in this context (recursion guard).",
        };
    }

    const { prompt } = v.value;
    const kind = resolveKind(v.value.kind, subagentCtx.projectRoot) as SubagentKind;
    if (!isKnownKind(kind, subagentCtx.projectRoot)) {
        return { ok: false, error: unknownKindError(kind, subagentCtx.projectRoot) };
    }

    const thoroughness = v.value.thoroughness;
    if (thoroughness !== undefined && !isThoroughness(thoroughness)) {
        return {
            ok: false,
            error: `thoroughness must be "quick" | "medium" | "very_thorough"`,
        };
    }

    let seedHistory: SubagentSpec["seedHistory"];
    if (kind === "fork") {
        seedHistory = subagentCtx.parentHistory;
        if (seedHistory.length === 0) {
            return {
                ok: false,
                error: 'fork has no conversation to inherit yet. Use kind="general" instead.',
            };
        }
    }

    const spec: SubagentSpec = {
        kind,
        prompt,
        ...(thoroughness ? { options: { thoroughness } } : {}),
        ...(seedHistory ? { seedHistory } : {}),
    };

    // Background is the default. The model opts into a blocking foreground run
    // only by passing run_in_background: false (when it needs the result before
    // its next action). Resolved after the recursion guard above, which already
    // rejects any Task call inside a subagent — so nesting can't reach here.
    const runInBackground = v.value.run_in_background ?? true;

    if (runInBackground) {
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
        const result = await spawn(spec, {
            parentProjectId: subagentCtx.projectId,
            parentProjectRoot: subagentCtx.projectRoot,
            parentSessionId: subagentCtx.parentSessionId,
            contextWindow: subagentCtx.contextWindow,
            config: subagentCtx.config,
            provider: subagentCtx.provider,
            signal: ctx.signal,
            onChildEvent,
        });
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
    get description() {
        return buildDescription();
    },
    annotations: { readOnlyHint: false },
    // Built fresh on every read: custom agents come from markdown on disk, so
    // the enum the model sees has to follow the catalogue, not a fixed union.
    get schema() {
        return buildSchema(listAgents().map((a) => a.name));
    },
    execute,
};
