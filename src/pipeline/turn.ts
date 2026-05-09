import type { Config } from "../config/index.ts";
import { runEventHooks } from "../hooks/index.ts";
import { ensureSelectedMemory } from "../memory/index.ts";
import { decide, USER_DENIED } from "../permissions/index.ts";
import type {
    PermissionPromptPayload,
    PromptReason,
    PromptResponse,
    ToolCall,
} from "../permissions/index.ts";
import type { Message, Provider, ToolCallRequest } from "../providers/index.ts";
import type { SessionHandle } from "../storage/index.ts";
import {
    assembleToolPool,
    getTool,
    isRequestModeFlip,
    isUserQuestion,
    type SubagentToolContext,
    type ToolContext,
    type ToolResult,
    type TurnState,
} from "../tools/index.ts";
import { assemble } from "./assemble.ts";
import { type CollectedToolCall } from "./dispatch.ts";
import { transcriptable, type Event, type StopReason } from "./events.ts";
import { runModelCallWithRecovery } from "./recovery.ts";
import { runShapers } from "./shapers/index.ts";
import { recordDenial, resetDenialTrail, resetShapingFlags, type SessionState } from "./state.ts";
import { evaluateStop } from "./stop.ts";

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

    // Reset per-turn flags.
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
                query: queryText,
                provider,
                config,
            });
        }
    }

    const activeModel = state.activeModel ?? config.defaultModel.model;

    // Step 3: assemble. Step 4: shapers (Budget Reduction → ... → Auto-Compact),
    // which may clamp the reply budget and/or rewrite state.history. Shapers
    // yield shaper.applied events as they fire.
    const initialMessages = await assemble({ state, model: activeModel });
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
        providerOptions: {
            providerOrder: config.defaultModel.providerOrder,
            allowFallbacks: config.defaultModel.allowFallbacks,
        },
    });

    let modelText = "";
    let toolCalls: readonly CollectedToolCall[] = [];

    while (true) {
        const next = await recoveryGen.next();
        if (next.done) {
            const out = next.value;
            modelText = out.result.text;
            toolCalls = out.result.toolCalls;
            // Persist any model/provider switch the recovery layer decided so
            // the rest of the turn (and the next turn) sees the new state.
            if (out.finalModel !== activeModel) {
                state.activeModel = out.finalModel;
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
    const assistantMessage = buildAssistantMessage(modelText, toolCalls);
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
        });
        if (decision.kind === "allow") parallelIds.add(call.id);
    }

    const parallelResults = new Map<string, ToolResult>();
    if (parallelIds.size > 0) {
        for (const call of toolCalls) {
            if (!parallelIds.has(call.id)) continue;
            const startEvent: Event = {
                type: "tool.start",
                id: call.id,
                name: call.name,
                args: call.args,
            };
            yield startEvent;
            await session.appendEvent(transcriptable(startEvent));
        }

        const parallelSubagentContext: SubagentToolContext | undefined =
            state.parentSessionId === undefined
                ? {
                      projectId: state.projectId,
                      projectRoot: state.projectRoot,
                      parentSessionId: state.sessionId,
                      contextWindow: state.contextWindow,
                      provider,
                      config,
                  }
                : undefined;

        type ParallelEvent =
            | {
                  readonly kind: "progress";
                  readonly id: string;
                  readonly lines: readonly string[];
              }
            | { readonly kind: "done"; readonly id: string; readonly result: ToolResult }
            | { readonly kind: "fatal"; readonly error: unknown };

        const queue: ParallelEvent[] = [];
        let wakeup = deferred<void>();

        let pending = 0;
        for (const call of toolCalls) {
            if (!parallelIds.has(call.id)) continue;
            pending += 1;
            void (async () => {
                try {
                    const preHook = await runEventHooks(
                        config.hooks,
                        "PreToolUse",
                        {
                            tool_name: call.name,
                            tool_args: call.args,
                            project_dir: state.projectRoot,
                        },
                        signal,
                    );
                    if (preHook.blocked) {
                        queue.push({
                            kind: "done",
                            id: call.id,
                            result: { ok: false, error: preHook.reason ?? "hook blocked" },
                        });
                        wakeup.resolve();
                        return;
                    }
                    const tool = getTool(call.name);
                    if (!tool) {
                        queue.push({
                            kind: "done",
                            id: call.id,
                            result: { ok: false, error: `unknown tool: ${call.name}` },
                        });
                        wakeup.resolve();
                        return;
                    }
                    const toolCtx: ToolContext = {
                        cwd: state.projectRoot,
                        signal,
                        sessionId: state.sessionId,
                        projectId: state.projectId,
                        turnIndex: state.globalTurnIndex,
                        turnState,
                        provider,
                        config,
                        activeModel,
                        log: () => {},
                        emitProgress: (lines) => {
                            queue.push({ kind: "progress", id: call.id, lines });
                            wakeup.resolve();
                        },
                        ...(parallelSubagentContext
                            ? { subagentContext: parallelSubagentContext }
                            : {}),
                    };
                    const result = await tool.execute(call.args, toolCtx);
                    queue.push({ kind: "done", id: call.id, result });
                    wakeup.resolve();
                } catch (error) {
                    queue.push({ kind: "fatal", error });
                    wakeup.resolve();
                }
            })();
        }

        let completed = 0;
        let firstError: unknown = null;
        while (completed < pending) {
            await wakeup.promise;
            wakeup = deferred<void>();
            while (queue.length > 0) {
                const ev = queue.shift()!;
                if (ev.kind === "progress") {
                    yield { type: "tool.progress", id: ev.id, lines: ev.lines };
                } else if (ev.kind === "done") {
                    parallelResults.set(ev.id, ev.result);
                    completed += 1;
                } else {
                    if (firstError === null) firstError = ev.error;
                    completed += 1;
                }
            }
        }
        if (firstError !== null) throw firstError;
    }

    for (const call of toolCalls) {
        if (parallelIds.has(call.id)) {
            const result = parallelResults.get(call.id);
            if (!result) continue;
            const endEvent: Event = {
                type: "tool.end",
                id: call.id,
                name: call.name,
                result,
            };
            yield endEvent;
            await session.appendEvent(transcriptable(endEvent));
            if (result.ok) {
                const args = call.args as Record<string, unknown> | undefined;
                const filePaths: string[] = [];
                if (args && typeof args["path"] === "string") filePaths.push(args["path"]);
                void runEventHooks(
                    config.hooks,
                    "PostToolUse",
                    {
                        tool_name: call.name,
                        tool_args: call.args,
                        ...(filePaths.length > 0 ? { file_paths: filePaths } : {}),
                        project_dir: state.projectRoot,
                    },
                    signal,
                );
            }
            state.history.push({
                role: "tool",
                tool_call_id: call.id,
                content: renderToolResult(result),
            });
            if (state.mode === "PLAN") resetDenialTrail(state);
            continue;
        }
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

        // PreToolUse hook: runs after permission gate, before execution.
        // Blocking (exit 2) skips execution and returns stderr to the model.
        const preHook = await runEventHooks(
            config.hooks,
            "PreToolUse",
            {
                tool_name: call.name,
                tool_args: call.args,
                project_dir: state.projectRoot,
            },
            signal,
        );
        if (preHook.blocked) {
            const result: ToolResult = {
                ok: false,
                error: preHook.reason ?? "hook blocked",
            };
            const endEvent: Event = { type: "tool.end", id: call.id, name: call.name, result };
            yield endEvent;
            await session.appendEvent(transcriptable(endEvent));
            state.history.push({
                role: "tool",
                tool_call_id: call.id,
                content: renderToolResult(result),
            });
            continue;
        }

        const subagentContext: SubagentToolContext | undefined =
            state.parentSessionId === undefined
                ? {
                      projectId: state.projectId,
                      projectRoot: state.projectRoot,
                      parentSessionId: state.sessionId,
                      contextWindow: state.contextWindow,
                      provider,
                      config,
                  }
                : undefined;

        // Progress plumbing: tools that wrap a long-running sub-process push
        // current action-line snapshots through emitProgress; we drain those
        // into tool.progress events while tool.execute is in flight.
        const progressQueue: Array<readonly string[]> = [];
        let wakeup = deferred<void>();

        const toolCtx: ToolContext = {
            cwd: state.projectRoot,
            signal,
            sessionId: state.sessionId,
            projectId: state.projectId,
            turnIndex: state.globalTurnIndex,
            turnState,
            provider,
            config,
            activeModel,
            log: () => {},
            emitProgress: (lines) => {
                progressQueue.push(lines);
                wakeup.resolve();
            },
            ...(subagentContext ? { subagentContext } : {}),
        };

        const execPromise = tool.execute(call.args, toolCtx);
        let executed = false;
        let hadError = false;
        let toolError: unknown = null;
        let toolResultRaw: ToolResult | null = null;
        execPromise.then(
            (r) => {
                toolResultRaw = r;
                executed = true;
                wakeup.resolve();
            },
            (e) => {
                toolError = e;
                hadError = true;
                executed = true;
                wakeup.resolve();
            },
        );

        while (true) {
            await wakeup.promise;
            wakeup = deferred<void>();
            while (progressQueue.length > 0) {
                const lines = progressQueue.shift()!;
                const progressEvent: Event = {
                    type: "tool.progress",
                    id: call.id,
                    lines,
                };
                yield progressEvent;
                // Volatile UI state — not persisted to the session transcript.
            }
            if (executed) break;
        }

        if (hadError) throw toolError;
        const result = toolResultRaw as unknown as ToolResult;

        // AskUserQuestion: surface the question to the UI, replace the tool's
        // payload-shaped result with the user's answer string before pushing it
        // into history. The model only sees the answer.
        let finalResult: ToolResult = result;
        if (result.ok && isUserQuestion(result.value)) {
            const d = deferred<string>();
            const qEvent: Event = {
                type: "userQuestion.prompt",
                id: call.id,
                payload: {
                    question: result.value.question,
                    options: result.value.options,
                    multiSelect: result.value.multiSelect,
                },
                respond: (answer) => d.resolve(answer),
            };
            yield qEvent;
            await session.appendEvent(transcriptable(qEvent));
            const answer = await d.promise;
            finalResult = { ok: true, value: answer };
        }

        const endEvent: Event = {
            type: "tool.end",
            id: call.id,
            name: call.name,
            result: finalResult,
        };
        yield endEvent;
        await session.appendEvent(transcriptable(endEvent));

        // PostToolUse hook: fire-and-forget after successful tool call.
        // Extract file paths from args for tools that carry a `path` field.
        if (finalResult.ok) {
            const args = call.args as Record<string, unknown> | undefined;
            const filePaths: string[] = [];
            if (args && typeof args["path"] === "string") filePaths.push(args["path"]);
            void runEventHooks(
                config.hooks,
                "PostToolUse",
                {
                    tool_name: call.name,
                    tool_args: call.args,
                    ...(filePaths.length > 0 ? { file_paths: filePaths } : {}),
                    project_dir: state.projectRoot,
                },
                signal,
            );
        }
        state.history.push({
            role: "tool",
            tool_call_id: call.id,
            content: renderToolResult(finalResult),
        });

        // ExitPlanMode / EnterPlanMode special-case: result shape signals a mode-flip prompt.
        if (result.ok && isRequestModeFlip(result.value)) {
            // No-op when already in the target mode: skip the prompt entirely.
            if (state.mode === result.value.target) {
                if (state.mode === "PLAN") resetDenialTrail(state);
                continue;
            }
            const d = deferred<PromptResponse>();
            const reason: PromptReason =
                result.value.target === "PLAN" ? "enter_plan_mode" : "exit_plan_mode";
            const flipPayload: PermissionPromptPayload = {
                reason,
                toolCall,
                target: result.value.target,
                ...(result.value.planPath ? { planPath: result.value.planPath } : {}),
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
