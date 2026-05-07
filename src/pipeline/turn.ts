import type { Config } from "../config/index.ts";
import { decide, USER_DENIED } from "../permissions/index.ts";
import type { PermissionPromptPayload, PromptResponse, ToolCall } from "../permissions/index.ts";
import type { Message, Provider, ToolCallRequest } from "../providers/index.ts";
import type { SessionHandle } from "../storage/index.ts";
import {
    assembleToolPool,
    getTool,
    isRequestModeFlip,
    type ToolContext,
    type ToolResult,
    type TurnState,
} from "../tools/index.ts";
import { assemble } from "./assemble.ts";
import { type CollectedToolCall, streamFromProvider } from "./dispatch.ts";
import { transcriptable, type Event, type StopReason } from "./events.ts";
import { autoCompact } from "./shapers/index.ts";
import { newTurnState, recordDenial, resetDenialTrail, type SessionState } from "./state.ts";
import { evaluateStop } from "./stop.ts";

export interface TurnDeps {
    readonly provider: Provider;
    readonly config: Config;
    readonly session: SessionHandle;
    readonly state: SessionState;
    readonly turnIndex: number;
    readonly maxTurns: number;
    readonly signal: AbortSignal;
}

interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
}

const deferred = <T>(): Deferred<T> => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

const buildAssistantMessage = (text: string, toolCalls: readonly CollectedToolCall[]): Message => {
    if (toolCalls.length === 0) {
        return { role: "assistant", content: text };
    }
    const tool_calls: ToolCallRequest[] = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
    }));
    return { role: "assistant", content: text.length > 0 ? text : null, tool_calls };
};

const renderToolResult = (result: ToolResult): string => {
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
    const { provider, config, session, state, turnIndex, maxTurns, signal } = deps;

    // Reset per-turn flags.
    state.compactedThisTurn = false;
    const turnState: TurnState = newTurnState();

    yield { type: "turn.start", turnIndex };
    await session.appendEvent({ type: "turn.start", turnIndex });

    // Steps 3 + 4: assemble + shapers (autoCompact may rewrite state.history).
    let messages = await assemble({ state, model: config.defaultModel.model });
    const compacted = await autoCompact({ state, messages, provider, config });
    if (compacted) {
        messages = await assemble({ state, model: config.defaultModel.model });
    }

    // Step 5 + start of step 6: model call + tool-call collection.
    const tools = assembleToolPool({
        mode: state.mode,
        rules: [...(config.permissions?.rules ?? []), ...state.sessionRules],
    });
    const streamGen = streamFromProvider(provider, {
        model: config.defaultModel.model,
        messages,
        tools,
        signal,
        providerOptions: {
            providerOrder: config.defaultModel.providerOrder,
            allowFallbacks: config.defaultModel.allowFallbacks,
        },
    });

    let modelText = "";
    let toolCalls: readonly CollectedToolCall[] = [];

    while (true) {
        const next = await streamGen.next();
        if (next.done) {
            modelText = next.value.text;
            toolCalls = next.value.toolCalls;
            if (next.value.stopReason === "error") {
                const errorEvent: Event = {
                    type: "turn.end",
                    stopReason: "error",
                    ...(next.value.error !== undefined ? { error: next.value.error } : {}),
                };
                yield errorEvent;
                await session.appendEvent(transcriptable(errorEvent));
                return "error";
            }
            break;
        }
        yield next.value;
        await session.appendEvent(transcriptable(next.value));
    }

    // Append assistant message to history (may have content + tool_calls).
    const assistantMessage = buildAssistantMessage(modelText, toolCalls);
    state.history.push(assistantMessage);

    // Steps 7 + 8: permission gate + tool execution. Sequential in v1.
    for (const call of toolCalls) {
        const toolCall: ToolCall = { id: call.id, name: call.name, args: call.args };
        const decision = decide({
            toolCall,
            mode: state.mode,
            rules: [...(config.permissions?.rules ?? []), ...state.sessionRules],
            isReadOnly: isToolReadOnly(call.name),
        });

        let allowed = decision.kind === "allow";

        if (decision.kind === "prompt") {
            const d = deferred<PromptResponse>();
            const promptPayload: PermissionPromptPayload = {
                reason: "tool_use",
                toolCall,
            };
            const promptEvent: Event = {
                type: "permission.prompt",
                payload: promptPayload,
                respond: (r) => d.resolve(r),
            };
            yield promptEvent;
            await session.appendEvent(transcriptable(promptEvent));
            const response = await d.promise;
            if (response === "allow_session") {
                state.sessionRules.push({ effect: "allow", tool: call.name });
                allowed = true;
            } else if (response === "allow_once") {
                allowed = true;
            } else {
                allowed = false;
            }
        }

        if (decision.kind === "deny") {
            // Already-denied at the gate (rule or PLAN block). Record the result and continue.
            const result: ToolResult = { ok: false, error: decision.message };
            const startEvent: Event = {
                type: "tool.start",
                id: call.id,
                name: call.name,
                args: call.args,
            };
            const endEvent: Event = { type: "tool.end", id: call.id, name: call.name, result };
            yield startEvent;
            await session.appendEvent(transcriptable(startEvent));
            yield endEvent;
            await session.appendEvent(transcriptable(endEvent));
            state.history.push({
                role: "tool",
                tool_call_id: call.id,
                content: renderToolResult(result),
            });
            if (state.mode === "PLAN") recordDenial(state, call.name);
            continue;
        }

        if (!allowed) {
            const result: ToolResult = { ok: false, error: USER_DENIED };
            const startEvent: Event = {
                type: "tool.start",
                id: call.id,
                name: call.name,
                args: call.args,
            };
            const endEvent: Event = { type: "tool.end", id: call.id, name: call.name, result };
            yield startEvent;
            await session.appendEvent(transcriptable(startEvent));
            yield endEvent;
            await session.appendEvent(transcriptable(endEvent));
            state.history.push({
                role: "tool",
                tool_call_id: call.id,
                content: renderToolResult(result),
            });
            continue;
        }

        // Allowed. Execute.
        const tool = getTool(call.name);
        if (!tool) {
            const result: ToolResult = { ok: false, error: `unknown tool: ${call.name}` };
            const startEvent: Event = {
                type: "tool.start",
                id: call.id,
                name: call.name,
                args: call.args,
            };
            const endEvent: Event = { type: "tool.end", id: call.id, name: call.name, result };
            yield startEvent;
            await session.appendEvent(transcriptable(startEvent));
            yield endEvent;
            await session.appendEvent(transcriptable(endEvent));
            state.history.push({
                role: "tool",
                tool_call_id: call.id,
                content: renderToolResult(result),
            });
            continue;
        }

        const startEvent: Event = {
            type: "tool.start",
            id: call.id,
            name: call.name,
            args: call.args,
        };
        yield startEvent;
        await session.appendEvent(transcriptable(startEvent));

        const toolCtx: ToolContext = {
            cwd: state.projectRoot,
            signal,
            sessionId: state.sessionId,
            projectId: state.projectId,
            turnState,
            log: () => {},
        };
        const result = await tool.execute(call.args, toolCtx);

        const endEvent: Event = { type: "tool.end", id: call.id, name: call.name, result };
        yield endEvent;
        await session.appendEvent(transcriptable(endEvent));
        state.history.push({
            role: "tool",
            tool_call_id: call.id,
            content: renderToolResult(result),
        });

        // ExitPlanMode special-case: result shape signals a mode-flip prompt.
        if (result.ok && isRequestModeFlip(result.value)) {
            const d = deferred<PromptResponse>();
            const flipPayload: PermissionPromptPayload = {
                reason: "exit_plan_mode",
                toolCall,
                planPath: result.value.planPath,
                target: result.value.target,
            };
            const flipEvent: Event = {
                type: "permission.prompt",
                payload: flipPayload,
                respond: (r) => d.resolve(r),
            };
            yield flipEvent;
            await session.appendEvent(transcriptable(flipEvent));
            const response = await d.promise;
            if (response === "allow_once" || response === "allow_session") {
                state.mode = result.value.target;
                resetDenialTrail(state);
                const modeEvent: Event = { type: "mode.changed", mode: state.mode };
                yield modeEvent;
                await session.appendEvent(transcriptable(modeEvent));
            }
        }

        // PLAN-mode loop guard: only PLAN-driven denials count, which were
        // already handled in the deny branch above. Successful tool runs reset.
        if (state.mode === "PLAN") resetDenialTrail(state);
    }

    // Step 9: stop condition check. null from evaluateStop means "continue".
    const stopReason: StopReason =
        evaluateStop({
            state,
            turnIndex,
            maxTurns,
            hadToolCalls: toolCalls.length > 0,
        }) ?? "continue";

    const turnEnd: Event = { type: "turn.end", stopReason };
    yield turnEnd;
    await session.appendEvent(transcriptable(turnEnd));

    return stopReason;
}
