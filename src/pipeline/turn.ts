import type { Config } from "../config/index.ts";
import { ensureSelectedMemory } from "../memory/index.ts";
import { decide } from "../permissions/index.ts";
import type { Message, Provider, ReasoningDetail, ToolCallRequest } from "../providers/index.ts";
import type { SessionHandle } from "../storage/index.ts";
import { assembleToolPool, getTool, type ToolResult, type TurnState } from "../tools/index.ts";
import { getBackgroundManager, formatBashResult } from "../tools/bash/background.ts";
import { getBackgroundSubagentManager } from "../subagents/background.ts";
import { assemble } from "./assemble.ts";
import { type CollectedToolCall } from "./dispatch.ts";
import { transcriptable, type Event, type StopReason } from "./events.ts";
import { runModelCallWithRecovery } from "./recovery.ts";
import { capturePinnedUpstream, resolveProviderOptions } from "./routing.ts";
import { runShapers } from "./shapers/index.ts";
import { resetShapingFlags, type SessionState } from "./state.ts";
import { executeToolCalls } from "./executeToolCalls.ts";
import { evaluateStop, PLAN_START_REMINDER, shouldNudgePlanStart } from "./stop.ts";

export interface TurnDeps {
    readonly provider: Provider;
    readonly config: Config;
    readonly session: SessionHandle;
    readonly state: SessionState;
    readonly turnState: TurnState;
    readonly turnIndex: number;
    readonly maxTurns: number;
    readonly signal: AbortSignal;
}

const buildAssistantMessage = (
    text: string,
    toolCalls: readonly CollectedToolCall[],
    reasoningDetails?: readonly ReasoningDetail[],
): Message => {
    const reasoning =
        reasoningDetails && reasoningDetails.length > 0
            ? { reasoning_details: reasoningDetails }
            : {};
    if (toolCalls.length === 0) {
        return { role: "assistant", content: text, ...reasoning };
    }
    const tool_calls: ToolCallRequest[] = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
    }));
    return {
        role: "assistant",
        content: text.length > 0 ? text : null,
        tool_calls,
        ...reasoning,
    };
};

// Render a tool result into the string the model sees as the tool message
// content. Free-form text tools (Read/Bash/Grep/Edit) MUST return a string so
// it passes through the first branch unchanged — going through JSON.stringify
// would double-escape backslashes/quotes and turn real newlines into `\n`
// escape sequences, leaving the model unable to count escape-prone characters
// reliably. The fallback only fires for tools whose value is a small bag of
// known-clean fields (e.g. Glob's `{ paths, truncated }`).
export const renderToolResult = (result: ToolResult): string => {
    if (!result.ok) return `Error: ${result.error}`;
    if (typeof result.value === "string") return result.value;
    return JSON.stringify(result.value);
};

const isToolReadOnly = (toolName: string): boolean => {
    const t = getTool(toolName);
    return Boolean(t?.annotations.readOnlyHint);
};

// One full 9-step turn. Yields Event values to the caller. Mutates `state`
// across turns within a session. The caller (queryLoop) drives turns until
// turn.end fires with a non-loop stop reason.
export async function* runTurn(deps: TurnDeps): AsyncGenerator<Event, StopReason> {
    const { provider, config, session, state, turnState, turnIndex, maxTurns, signal } = deps;

    // Reset per-turn flags. Capture (then clear) the plan-just-approved flag
    // before the tool loop can re-set it: it must reflect the *previous* turn's
    // approval, so acting on it this turn signals a stall after acceptance.
    const planAcceptedComingIn = state.planJustAccepted === true;
    state.planJustAccepted = false;
    state.compactedThisTurn = false;
    resetShapingFlags(state);
    // Monotonic counter — used by Edit/Write to scope file checkpoints. Each
    // turn (across all user prompts in this session) gets a unique value.
    state.globalTurnIndex += 1;

    yield { type: "turn.start", turnIndex };
    await session.appendEvent({ type: "turn.start", turnIndex });

    // Auto-memory: populate once per session, gated on a non-empty user query.
    if (state.selectedMemory === null) {
        const lastUser = [...state.history].reverse().find((m) => m.role === "user");
        const queryText = lastUser && typeof lastUser.content === "string" ? lastUser.content : "";
        if (queryText.length > 0) {
            state.selectedMemory = await ensureSelectedMemory({
                projectId: state.projectId,
                sessionId: state.sessionId,
                query: queryText,
                provider,
                config,
            });
        }
    }

    // Drain completed background bash tasks and inject their output into
    // history so the model sees them at the start of this turn.
    const bgMgr = getBackgroundManager(state.sessionId);
    for (const task of bgMgr.drainCompleted()) {
        const durationMs = Date.now() - task.startedAt;
        const output = formatBashResult(task.stdout, task.stderr, task.exitCode ?? 1, durationMs);
        state.history.push({
            role: "user",
            content: `<system-reminder>\nBackground task ${task.id} finished.\n${output}\n</system-reminder>`,
        });
    }

    // Drain completed background subagents and inject their summaries. State the
    // liveness explicitly — whether it finished or died, and how many are still
    // running — so a dead subagent can never leave the model waiting on a ghost.
    const subagentMgr = getBackgroundSubagentManager(state.sessionId);
    for (const task of subagentMgr.drainCompleted()) {
        const durationMs = Date.now() - task.startedAt;
        const stillRunning = subagentMgr.runningCount();
        const runningNote =
            stillRunning === 0
                ? "0 background subagents are running now — none left to wait for."
                : `${stillRunning} background subagent${stillRunning === 1 ? "" : "s"} still running.`;
        let body: string;
        if (task.status === "completed") {
            body = `Background subagent ${task.id} (${task.kind}) completed after ${durationMs}ms and is no longer running.\n${task.summary}`;
        } else {
            const reason = task.error || "no details";
            body =
                `Background subagent ${task.id} (${task.kind}) ${task.status} after ${durationMs}ms — it is now 100% gone and will send NO result. ` +
                `Do not wait on it. If its task still needs doing, start a fresh subagent. Reason: ${reason}`;
        }
        state.history.push({
            role: "user",
            content: `<system-reminder>\n${body}\n${runningNote}\n</system-reminder>`,
        });
    }

    const activeModel = state.activeModel ?? config.defaultModel.model;

    // Step 3: assemble. Step 4: shapers (Budget Reduction → ... → Auto-Compact),
    // which may clamp the reply budget and/or rewrite state.history. Shapers
    // yield shaper.applied events as they fire.
    const initialMessages = await assemble({
        state,
        model: activeModel,
        providerId: provider.id,
    });
    const shaperGen = runShapers({
        state,
        initialMessages,
        provider,
        config,
        model: activeModel,
    });
    let messages: Message[];
    let budget;
    while (true) {
        const next = await shaperGen.next();
        if (next.done) {
            messages = next.value.messages;
            budget = next.value.budget;
            break;
        }
        yield next.value;
        await session.appendEvent(transcriptable(next.value));
    }

    // Step 5 + start of step 6: model call + tool-call collection.
    const webSearchAvailable =
        provider.capabilities.serverSideWebSearch ||
        (config.webTools?.searchFallback ?? "duckduckgo") !== "off";
    const tools = assembleToolPool({
        mode: state.mode,
        rules: [...(config.permissions?.rules ?? []), ...state.sessionRules],
        webSearchAvailable,
        headless: state.headless,
        ...(state.allowedTools ? { allowedTools: state.allowedTools } : {}),
    });
    const recoveryGen = runModelCallWithRecovery({
        state,
        config,
        initialProvider: provider,
        initialModel: activeModel,
        budget,
        initialMessages: messages,
        tools,
        signal,
        providerOptions: resolveProviderOptions(config, state, activeModel),
    });

    let modelText = "";
    let toolCalls: readonly CollectedToolCall[] = [];
    let reasoningDetails: readonly ReasoningDetail[] | undefined;

    while (true) {
        const next = await recoveryGen.next();
        if (next.done) {
            const out = next.value;
            modelText = out.result.text;
            toolCalls = out.result.toolCalls;
            reasoningDetails = out.result.reasoningDetails;
            // Persist any model/provider switch the recovery layer decided so
            // the rest of the turn (and the next turn) sees the new state.
            if (out.finalModel !== activeModel) {
                state.activeModel = out.finalModel;
            }
            // For sticky routing: pin this model to whichever upstream served
            // the first turn. Subsequent turns will route there explicitly.
            if (out.result.usage?.upstream) {
                capturePinnedUpstream(state, config, out.finalModel, out.result.usage.upstream);
            }
            if (out.result.stopReason === "error") {
                const errorEvent: Event = {
                    type: "turn.end",
                    stopReason: "error",
                    ...(out.result.error !== undefined ? { error: out.result.error } : {}),
                };
                yield errorEvent;
                await session.appendEvent(transcriptable(errorEvent));
                return "error";
            }
            if (out.result.stopReason === "abort") {
                const cancelEvent: Event = { type: "turn.end", stopReason: "user_cancel" };
                yield cancelEvent;
                await session.appendEvent(transcriptable(cancelEvent));
                return "user_cancel";
            }
            break;
        }
        yield next.value;
        await session.appendEvent(transcriptable(next.value));
    }

    // Append assistant message to history (may have content + tool_calls).
    const assistantMessage = buildAssistantMessage(modelText, toolCalls, reasoningDetails);
    state.history.push(assistantMessage);

    // Steps 7 + 8: permission gate + tool execution.
    // Read-only tools that the gate allows fan out via Promise.all up front;
    // everything else (state-modifying tools, prompts, denies, AskUserQuestion)
    // runs in the sequential loop below. AskUserQuestion is read-only-annotated
    // but its result triggers an interactive userQuestion.prompt, so it stays
    // sequential.
    const parallelIds = new Set<string>();
    for (const call of toolCalls) {
        if (!isToolReadOnly(call.name)) continue;
        if (call.name === "AskUserQuestion") continue;
        const decision = decide({
            toolCall: { id: call.id, name: call.name, args: call.args },
            mode: state.mode,
            rules: [...(config.permissions?.rules ?? []), ...state.sessionRules],
            isReadOnly: true,
            heuristicGating: config.permissions?.heuristicGating,
        });
        if (decision.kind === "allow") parallelIds.add(call.id);
    }

    yield* executeToolCalls({
        toolCalls,
        session,
        state,
        turnState,
        config,
        provider,
        activeModel,
        signal,
        parallelIds,
    });

    // Step 9: stop condition check. null from evaluateStop means "continue".
    let stopReason: StopReason =
        evaluateStop({
            state,
            turnIndex,
            maxTurns,
            hadToolCalls: toolCalls.length > 0,
        }) ?? "continue";

    // A plan was approved last turn and the model just acknowledged instead of
    // executing. Inject a start-now nudge and keep looping (once — the flag was
    // already cleared at turn top, so a repeat stall ends normally).
    if (shouldNudgePlanStart(planAcceptedComingIn, stopReason)) {
        state.history.push({ role: "user", content: PLAN_START_REMINDER });
        stopReason = "continue";
    }

    const turnEnd: Event = { type: "turn.end", stopReason };
    yield turnEnd;
    await session.appendEvent(transcriptable(turnEnd));

    return stopReason;
}
