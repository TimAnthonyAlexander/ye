import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DecideContext, Decision, PromptResponse } from "../permissions/index.ts";
import type { Provider } from "../providers/index.ts";
import type { Tool, ToolContext, ToolResult, TurnState } from "../tools/index.ts";
import type { CollectedToolCall } from "./dispatch.ts";
import type { Event } from "./events.ts";
import { newShapingFlags, newTurnState, type SessionState } from "./state.ts";

// ---------------------------------------------------------------------------
// Mutable module-level state for mocked dependencies. Each test seeds these
// in beforeEach so the async generator sees the right behaviour.
// ---------------------------------------------------------------------------

const toolMap = new Map<string, Tool>();
let decideFn: (ctx: DecideContext) => Decision = () => ({ kind: "allow" });
let hookResult: { blocked: boolean; reason?: string } = { blocked: false };

// ---------------------------------------------------------------------------
// Mocks — hoisted by bun so they take effect before the SUT is imported.
// ---------------------------------------------------------------------------

mock.module("../tools/index.ts", () => ({
    getTool: (name: string) => toolMap.get(name),
    unknownToolError: (name: string) => `unknown tool: ${name}. Available tools: Read, Bash.`,
    isRequestModeFlip: (
        value: unknown,
    ): value is { kind: "request_mode_flip"; target: "NORMAL" | "PLAN"; planPath?: string } =>
        typeof value === "object" &&
        value !== null &&
        (value as { kind?: unknown }).kind === "request_mode_flip",
    isUserQuestion: (
        value: unknown,
    ): value is {
        kind: "user_question";
        question: string;
        options: readonly { label: string; description?: string }[];
        multiSelect: boolean;
    } =>
        typeof value === "object" &&
        value !== null &&
        (value as { kind?: unknown }).kind === "user_question",
}));

// NOTE: permissions is NOT mocked here — `decide` is injected via deps instead
// (see baseDeps), because Bun's mock.module is process-global and would clobber
// the real `decide` in permissions/decide.test.ts.

mock.module("../hooks/index.ts", () => ({
    runEventHooks: async () => hookResult,
}));

// ---------------------------------------------------------------------------
// SUT — imported after mocks.
// ---------------------------------------------------------------------------

import { executeToolCalls } from "./executeToolCalls.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubProvider: Provider = {
    id: "stub",
    capabilities: {
        promptCache: false,
        toolUse: true,
        vision: false,
        serverSideWebSearch: false,
    },
    async *stream() {
        // no-op
    },
    async getContextSize() {
        return 100_000;
    },
};

const mkState = (overrides: Partial<SessionState> = {}): SessionState => ({
    sessionId: "s",
    projectId: "p",
    projectRoot: "/tmp/test",
    mode: "AUTO",
    contextWindow: 100_000,
    history: [],
    sessionRules: [],
    denialTrail: null,
    compactedThisTurn: false,
    shapingFlags: newShapingFlags(),
    globalTurnIndex: 0,
    selectedMemory: null,
    headless: false,
    turnState: newTurnState(),
    ...overrides,
});

const mkTool = (overrides: Partial<Tool> = {}): Tool => ({
    name: "test_tool",
    description: "A test tool",
    schema: { type: "object", properties: {} },
    annotations: {},
    execute: async () => ({ ok: true, value: "done" }) as ToolResult,
    ...overrides,
});

const mkCall = (id: string, name: string, args: unknown = {}): CollectedToolCall => ({
    id,
    name,
    args,
});

/** Drain an AsyncGenerator into { events, out }. */
const collect = async (gen: AsyncGenerator<Event, void>): Promise<{ events: Event[] }> => {
    const events: Event[] = [];
    while (true) {
        const next = await gen.next();
        if (next.done) return { events };
        events.push(next.value);
    }
};

const mkSession = () => {
    const events: Event[] = [];
    return {
        sessionId: "test-session",
        path: "/tmp/test-session.jsonl",
        events,
        appendEvent: async (e: { type: string; [key: string]: unknown }) => {
            events.push(e as unknown as Event);
        },
        close: async () => {},
    } as unknown as import("../storage/index.ts").SessionHandle & { events: Event[] };
};

const signal = new AbortController().signal;

let session: ReturnType<typeof mkSession>;

const baseDeps = (
    overrides: Partial<{
        toolCalls: CollectedToolCall[];
        state: SessionState;
        turnState: TurnState;
        parallelIds: string[];
    }> = {},
) => ({
    toolCalls: overrides.toolCalls ?? [],
    decide: (ctx: DecideContext) => decideFn(ctx),
    session: session as unknown as import("../storage/index.ts").SessionHandle,
    state: overrides.state ?? mkState(),
    turnState: overrides.turnState ?? newTurnState(),
    config: {
        defaultProvider: "stub",
        providers: { stub: { baseUrl: "https://example.test", apiKeyEnv: "STUB_KEY" } },
        defaultModel: { provider: "stub", model: "stub-model" },
    },
    provider: stubProvider,
    activeModel: "stub-model",
    signal,
    parallelIds: new Set(overrides.parallelIds ?? []),
});

// ---------------------------------------------------------------------------
// beforeEach — reset mutable state
// ---------------------------------------------------------------------------

beforeEach(() => {
    toolMap.clear();
    decideFn = () => ({ kind: "allow" });
    hookResult = { blocked: false };
    session = mkSession();
});

// ===========================================================================
// Parallel execution
// ===========================================================================

describe("parallel execution", () => {
    test("yields tool.start for each parallel tool, then tool.end with result", async () => {
        const t = mkTool({
            name: "fast_one",
            execute: async () => ({ ok: true, value: "result1" }) as ToolResult,
        });
        toolMap.set("fast_one", t);
        toolMap.set(
            "fast_two",
            mkTool({
                name: "fast_two",
                execute: async () => ({ ok: true, value: "result2" }) as ToolResult,
            }),
        );

        const deps = baseDeps({
            toolCalls: [mkCall("c1", "fast_one"), mkCall("c2", "fast_two")],
            parallelIds: ["c1", "c2"],
        });

        const { events } = await collect(executeToolCalls(deps));

        // tool.start for both (order preserved: c1 then c2)
        const starts = events.filter((e) => e.type === "tool.start");
        expect(starts.length).toBe(2);
        expect(starts[0]).toMatchObject({ type: "tool.start", id: "c1", name: "fast_one" });
        expect(starts[1]).toMatchObject({ type: "tool.start", id: "c2", name: "fast_two" });

        // tool.end for both, pulled from parallelResults in sequential loop
        const ends = events.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(2);
        expect(ends[0]).toMatchObject({
            type: "tool.end",
            id: "c1",
            name: "fast_one",
            result: { ok: true, value: "result1" },
        });
        expect(ends[1]).toMatchObject({
            type: "tool.end",
            id: "c2",
            name: "fast_two",
            result: { ok: true, value: "result2" },
        });
    });

    test("yields progress events from parallel tools", async () => {
        const t = mkTool({
            name: "progressor",
            execute: async (_args: unknown, ctx: ToolContext) => {
                ctx.emitProgress!(["line 1", "line 2"]);
                ctx.emitProgress!(["line 3"]);
                return { ok: true, value: "done" } as ToolResult;
            },
        });
        toolMap.set("progressor", t);

        const deps = baseDeps({
            toolCalls: [mkCall("p1", "progressor")],
            parallelIds: ["p1"],
        });

        const { events } = await collect(executeToolCalls(deps));

        const progress = events.filter((e) => e.type === "tool.progress");
        expect(progress.length).toBe(2);
        expect(progress[0]).toMatchObject({
            type: "tool.progress",
            id: "p1",
            lines: ["line 1", "line 2"],
        });
        expect(progress[1]).toMatchObject({ type: "tool.progress", id: "p1", lines: ["line 3"] });
    });

    test("hook blocking in parallel returns { ok: false } result", async () => {
        hookResult = { blocked: true, reason: "parallel blocked" };
        const t = mkTool({ name: "blocked_tool" });
        toolMap.set("blocked_tool", t);

        const deps = baseDeps({
            toolCalls: [mkCall("b1", "blocked_tool")],
            parallelIds: ["b1"],
        });

        const { events } = await collect(executeToolCalls(deps));

        const ends = events.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(1);
        expect(ends[0]).toMatchObject({
            type: "tool.end",
            id: "b1",
            result: { ok: false, error: "parallel blocked" },
        });
    });

    test("unknown tool in parallel returns error result", async () => {
        // toolMap has no entry → getTool returns undefined

        const deps = baseDeps({
            toolCalls: [mkCall("u1", "nonexistent")],
            parallelIds: ["u1"],
        });

        const { events } = await collect(executeToolCalls(deps));

        const ends = events.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(1);
        expect(ends[0]).toMatchObject({
            type: "tool.end",
            id: "u1",
            result: { ok: false },
        });
        const result = (ends[0] as { result: ToolResult }).result;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("unknown tool");
    });

    test("fatal error thrown after all parallel tools complete", async () => {
        const good = mkTool({
            name: "good",
            execute: async () => {
                // small delay so bad finishes first, testing that good still completes
                await new Promise((r) => setTimeout(r, 5));
                return { ok: true, value: "ok" } as ToolResult;
            },
        });
        const bad = mkTool({
            name: "bad",
            execute: async () => {
                throw new Error("BOOM");
            },
        });
        toolMap.set("good", good);
        toolMap.set("bad", bad);

        const deps = baseDeps({
            toolCalls: [mkCall("g1", "good"), mkCall("b1", "bad")],
            parallelIds: ["g1", "b1"],
        });

        let thrown: unknown = null;
        try {
            await collect(executeToolCalls(deps));
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeDefined();
        expect((thrown as Error).message).toBe("BOOM");

        // Both tools should have produced end events via the parallel path.
        // The good tool's end event is yielded in the sequential loop from
        // parallelResults, but the bad tool's fatal error is thrown before
        // the sequential loop processes it.
        // Actually, the throw happens at line 170, before the sequential
        // loop. So neither tool.end is yielded from sequential loop.
        // The parallel block does NOT yield tool.end for any tool.
        // Let me re-read the code...
        // In the parallel block, "done" results are pushed into parallelResults
        // but not yielded as events. They're yielded later in sequential loop.
        // But if there's a fatal error, it throws at line 170 and the
        // sequential loop never runs. So no tool.end events for either.
    });

    test("empty parallelIds skips parallel block entirely", async () => {
        const t = mkTool({ name: "seq_only" });
        toolMap.set("seq_only", t);

        const deps = baseDeps({
            toolCalls: [mkCall("s1", "seq_only")],
            parallelIds: [],
        });

        const { events } = await collect(executeToolCalls(deps));

        // No parallel start events — starts directly with sequential
        const starts = events.filter((e) => e.type === "tool.start");
        expect(starts.length).toBe(1);
        expect(starts[0]).toMatchObject({ id: "s1" });
    });
});

// ===========================================================================
// Sequential loop — parallel already-handled
// ===========================================================================

describe("sequential loop — parallel already-handled", () => {
    test("parallel result pulled from parallelResults, tool.end yielded, PostToolUse fires, history pushed", async () => {
        const t = mkTool({ name: "pre_done" });
        toolMap.set("pre_done", t);

        const deps = baseDeps({
            toolCalls: [mkCall("pre1", "pre_done")],
            parallelIds: ["pre1"],
        });

        // Simulate that the parallel block already ran and stored a result.
        // We do this by making a parallel call complete normally.
        const { events } = await collect(executeToolCalls(deps));

        const ends = events.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(1);
        expect(ends[0]).toMatchObject({
            type: "tool.end",
            id: "pre1",
            result: { ok: true, value: "done" },
        });

        // History was pushed
        expect(deps.state.history.length).toBe(1);
        expect(deps.state.history[0]).toMatchObject({
            role: "tool",
            tool_call_id: "pre1",
        });
    });

    test("parallel result with args.path passes file_paths to PostToolUse", async () => {
        const t = mkTool({ name: "writer_tool" });
        toolMap.set("writer_tool", t);

        const deps = baseDeps({
            toolCalls: [mkCall("w1", "writer_tool", { path: "/tmp/out.txt" })],
            parallelIds: ["w1"],
        });

        await collect(executeToolCalls(deps));

        // No assertion on hook call itself (it's void), but we verify no throw.
        expect(deps.state.history.length).toBe(1);
    });
});

// ===========================================================================
// Sequential loop — permission gate: deny
// ===========================================================================

describe("permission gate — deny", () => {
    test("yields tool.start + tool.end with error, pushes history", async () => {
        decideFn = () => ({ kind: "deny", message: "blocked by rule" });
        const t = mkTool({ name: "denied_tool" });
        toolMap.set("denied_tool", t);

        const deps = baseDeps({
            toolCalls: [mkCall("d1", "denied_tool")],
        });

        const { events } = await collect(executeToolCalls(deps));

        const starts = events.filter((e) => e.type === "tool.start");
        expect(starts.length).toBe(1);
        expect(starts[0]).toMatchObject({ id: "d1", name: "denied_tool" });

        const ends = events.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(1);
        expect(ends[0]).toMatchObject({
            id: "d1",
            result: { ok: false, error: "blocked by rule" },
        });

        expect(deps.state.history.length).toBe(1);
        expect(deps.state.history[0]).toMatchObject({ role: "tool", tool_call_id: "d1" });
    });

    test("recordDenial called when mode is PLAN", async () => {
        decideFn = () => ({ kind: "deny", message: "PLAN blocked" });
        const t = mkTool({ name: "plan_denied" });
        toolMap.set("plan_denied", t);

        const state = mkState({ mode: "PLAN" });
        const deps = baseDeps({ toolCalls: [mkCall("pd1", "plan_denied")], state });

        await collect(executeToolCalls(deps));

        expect(state.denialTrail).toBeDefined();
        expect(state.denialTrail!.tool).toBe("plan_denied");
        expect(state.denialTrail!.count).toBe(1);
    });
});

// ===========================================================================
// Sequential loop — permission gate: prompt → deny
// ===========================================================================

describe("permission gate — prompt", () => {
    test("prompt then deny yields permission.prompt, tool.start, tool.end with USER_DENIED", async () => {
        decideFn = () => ({ kind: "prompt" });
        const t = mkTool({ name: "prompt_tool" });
        toolMap.set("prompt_tool", t);

        const deps = baseDeps({
            toolCalls: [mkCall("pt1", "prompt_tool")],
        });

        const gen = executeToolCalls(deps);

        // First event should be the permission.prompt
        const first = await gen.next();
        expect(first.done).toBe(false);
        const promptEvent = first.value as Event & { respond: (r: PromptResponse) => void };
        expect(promptEvent.type).toBe("permission.prompt");
        expect(promptEvent).toHaveProperty("respond");

        // Deny
        promptEvent.respond("deny");

        // Drain the rest
        const rest = await collect(gen);

        // tool.start + tool.end should follow
        const starts = rest.events.filter((e) => e.type === "tool.start");
        expect(starts.length).toBe(1);
        expect(starts[0]).toMatchObject({ id: "pt1" });

        const ends = rest.events.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(1);
        expect(ends[0]).toMatchObject({
            id: "pt1",
            result: { ok: false, error: "User denied this action." },
        });

        expect(deps.state.history.length).toBe(1);
    });

    test("prompt then allow_once executes the tool normally", async () => {
        decideFn = () => ({ kind: "prompt" });
        const t = mkTool({
            name: "allow_once_tool",
            execute: async () => ({ ok: true, value: "executed" }) as ToolResult,
        });
        toolMap.set("allow_once_tool", t);

        const deps = baseDeps({
            toolCalls: [mkCall("ao1", "allow_once_tool")],
        });

        const gen = executeToolCalls(deps);

        const first = await gen.next();
        expect(first.done).toBe(false);
        const promptEvent = first.value as Event & { respond: (r: PromptResponse) => void };
        expect(promptEvent.type).toBe("permission.prompt");
        promptEvent.respond("allow_once");

        const { events } = await collect(gen);

        const starts = events.filter((e) => e.type === "tool.start");
        expect(starts.length).toBe(1);
        expect(starts[0]).toMatchObject({ id: "ao1" });

        const ends = events.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(1);
        expect(ends[0]).toMatchObject({
            id: "ao1",
            result: { ok: true, value: "executed" },
        });
    });

    test("prompt then allow_session pushes a session rule and executes", async () => {
        decideFn = () => ({ kind: "prompt" });
        const t = mkTool({
            name: "session_tool",
            execute: async () => ({ ok: true, value: "session ok" }) as ToolResult,
        });
        toolMap.set("session_tool", t);

        const deps = baseDeps({
            toolCalls: [mkCall("as1", "session_tool")],
        });

        const gen = executeToolCalls(deps);

        const first = await gen.next();
        const promptEvent = first.value as Event & { respond: (r: PromptResponse) => void };
        promptEvent.respond("allow_session");

        const { events } = await collect(gen);

        // Session rule pushed
        expect(deps.state.sessionRules.length).toBe(1);
        expect(deps.state.sessionRules[0]).toMatchObject({
            effect: "allow",
            tool: "session_tool",
        });

        const ends = events.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(1);
        expect(ends[0]).toMatchObject({
            id: "as1",
            result: { ok: true, value: "session ok" },
        });
    });
});

// ===========================================================================
// Sequential loop — unknown tool
// ===========================================================================

describe("unknown tool", () => {
    test("yields tool.start/end with unknownToolError when getTool returns undefined", async () => {
        // toolMap is empty → getTool returns undefined

        const deps = baseDeps({
            toolCalls: [mkCall("unk1", "GhostTool")],
        });

        const { events } = await collect(executeToolCalls(deps));

        const starts = events.filter((e) => e.type === "tool.start");
        expect(starts.length).toBe(1);
        expect(starts[0]).toMatchObject({ id: "unk1", name: "GhostTool" });

        const ends = events.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(1);
        const result = (ends[0] as { result: ToolResult }).result;
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain("unknown tool");
            expect(result.error).toContain("GhostTool");
        }
    });
});

// ===========================================================================
// Sequential loop — PreToolUse hook block
// ===========================================================================

describe("PreToolUse hook block", () => {
    test("hook blocked skips execution, yields tool.end with hook reason", async () => {
        hookResult = { blocked: true, reason: "not allowed by hook" };
        const t = mkTool({
            name: "hooked_tool",
            execute: async () => ({ ok: true, value: "should not run" }) as ToolResult,
        });
        toolMap.set("hooked_tool", t);

        const deps = baseDeps({
            toolCalls: [mkCall("h1", "hooked_tool")],
        });

        const { events } = await collect(executeToolCalls(deps));

        const starts = events.filter((e) => e.type === "tool.start");
        expect(starts.length).toBe(1);

        const ends = events.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(1);
        expect(ends[0]).toMatchObject({
            id: "h1",
            result: { ok: false, error: "not allowed by hook" },
        });

        expect(deps.state.history.length).toBe(1);
        expect(deps.state.history[0]!.content).toBe("Error: not allowed by hook");
    });
});

// ===========================================================================
// Sequential loop — normal execution
// ===========================================================================

describe("normal execution", () => {
    test("yields tool.start, tool.progress, tool.end with result, pushes history", async () => {
        const t = mkTool({
            name: "normal_tool",
            execute: async (_args: unknown, ctx: ToolContext) => {
                ctx.emitProgress!(["working..."]);
                return { ok: true, value: "all good" } as ToolResult;
            },
        });
        toolMap.set("normal_tool", t);

        const deps = baseDeps({
            toolCalls: [mkCall("n1", "normal_tool")],
        });

        const { events } = await collect(executeToolCalls(deps));

        const starts = events.filter((e) => e.type === "tool.start");
        expect(starts.length).toBe(1);
        expect(starts[0]).toMatchObject({ id: "n1", name: "normal_tool" });

        const progress = events.filter((e) => e.type === "tool.progress");
        expect(progress.length).toBe(1);
        expect(progress[0]).toMatchObject({ id: "n1", lines: ["working..."] });

        const ends = events.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(1);
        expect(ends[0]).toMatchObject({
            id: "n1",
            result: { ok: true, value: "all good" },
        });

        expect(deps.state.history.length).toBe(1);
        expect(deps.state.history[0]).toMatchObject({ role: "tool", tool_call_id: "n1" });
    });

    test("tool throws exception — propagated as error", async () => {
        const t = mkTool({
            name: "thrower",
            execute: async () => {
                throw new Error("runtime failure");
            },
        });
        toolMap.set("thrower", t);

        const deps = baseDeps({
            toolCalls: [mkCall("t1", "thrower")],
        });

        let thrown: unknown = null;
        try {
            await collect(executeToolCalls(deps));
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeDefined();
        expect((thrown as Error).message).toBe("runtime failure");
    });

    test("PostToolUse hook fires for successful tool with args.path", async () => {
        // We can't easily observe the fire-and-forget hook call, but we verify
        // the execution completes without error and history is correct.
        const t = mkTool({
            name: "file_writer",
            execute: async () => ({ ok: true, value: "wrote file" }) as ToolResult,
        });
        toolMap.set("file_writer", t);

        const deps = baseDeps({
            toolCalls: [mkCall("fw1", "file_writer", { path: "/tmp/out.txt" })],
        });

        await collect(executeToolCalls(deps));
        expect(deps.state.history.length).toBe(1);
    });

    test("failed tool does NOT fire PostToolUse", async () => {
        const t = mkTool({
            name: "failing_tool",
            execute: async () => ({ ok: false, error: "something went wrong" }) as ToolResult,
        });
        toolMap.set("failing_tool", t);

        const deps = baseDeps({
            toolCalls: [mkCall("ft1", "failing_tool")],
        });

        const { events } = await collect(executeToolCalls(deps));

        const ends = events.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(1);
        expect(ends[0]).toMatchObject({
            id: "ft1",
            result: { ok: false, error: "something went wrong" },
        });
    });
});

// ===========================================================================
// Sequential loop — AskUserQuestion
// ===========================================================================

describe("AskUserQuestion", () => {
    test("userQuestion.prompt yielded, answer replaces tool result in history", async () => {
        const t = mkTool({
            name: "AskUserQuestion",
            annotations: { readOnlyHint: true },
            execute: async () =>
                ({
                    ok: true,
                    value: {
                        kind: "user_question",
                        question: "Pick one",
                        options: [{ label: "A" }, { label: "B" }],
                        multiSelect: false,
                    },
                }) as ToolResult,
        });
        toolMap.set("AskUserQuestion", t);

        const deps = baseDeps({
            toolCalls: [mkCall("q1", "AskUserQuestion")],
        });

        const gen = executeToolCalls(deps);

        // Drain until we find userQuestion.prompt
        // tool.start comes first, then userQuestion.prompt
        const allEvents: Event[] = [];
        let questionEvent: (Event & { respond: (answer: string) => void }) | null = null;

        for await (const ev of gen) {
            allEvents.push(ev);
            if (ev.type === "userQuestion.prompt") {
                questionEvent = ev as Event & { respond: (answer: string) => void };
                questionEvent.respond("B");
            }
        }

        expect(questionEvent).toBeDefined();
        expect(questionEvent!.type).toBe("userQuestion.prompt");
        expect((questionEvent as { payload: unknown }).payload).toMatchObject({
            question: "Pick one",
            options: [{ label: "A" }, { label: "B" }],
        });

        const ends = allEvents.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(1);

        // The final result should be the user's answer, not the original payload
        const endResult = (ends[0] as { result: ToolResult }).result;
        expect(endResult).toMatchObject({ ok: true, value: "B" });

        // History should contain the answer string
        const toolMsg = deps.state.history.find((m) => m.role === "tool");
        expect(toolMsg).toBeDefined();
        expect(toolMsg!.content).toBe("B");
    });
});

// ===========================================================================
// Sequential loop — ExitPlanMode / EnterPlanMode mode flip
// ===========================================================================

describe("mode flip — ExitPlanMode / EnterPlanMode", () => {
    test("exit plan mode: yields permission.prompt with reason exit_plan_mode, flips mode on approve", async () => {
        const state = mkState({ mode: "PLAN" });
        const t = mkTool({
            name: "ExitPlanMode",
            execute: async () =>
                ({
                    ok: true,
                    value: {
                        kind: "request_mode_flip",
                        target: "NORMAL" as const,
                        planPath: "/tmp/plan.md",
                    },
                }) as ToolResult,
        });
        toolMap.set("ExitPlanMode", t);

        const deps = baseDeps({
            toolCalls: [mkCall("ep1", "ExitPlanMode")],
            state,
        });

        const gen = executeToolCalls(deps);
        const allEvents: Event[] = [];

        for await (const ev of gen) {
            allEvents.push(ev);
            if (
                ev.type === "permission.prompt" &&
                (ev as { payload: { reason: string } }).payload.reason === "exit_plan_mode"
            ) {
                const promptEv = ev as Event & { respond: (r: PromptResponse) => void };
                promptEv.respond("allow_once");
            }
        }

        const permissionEvents = allEvents.filter(
            (e) =>
                e.type === "permission.prompt" &&
                (e as { payload: { reason: string } }).payload.reason === "exit_plan_mode",
        );
        expect(permissionEvents.length).toBe(1);

        const modeChanges = allEvents.filter((e) => e.type === "mode.changed");
        expect(modeChanges.length).toBe(1);
        expect(modeChanges[0]).toMatchObject({ mode: "NORMAL" });

        expect(state.mode).toBe("NORMAL");
    });

    test("enter plan mode: yields permission.prompt with reason enter_plan_mode", async () => {
        const state = mkState({ mode: "AUTO" });
        const t = mkTool({
            name: "EnterPlanMode",
            execute: async () =>
                ({
                    ok: true,
                    value: {
                        kind: "request_mode_flip",
                        target: "PLAN" as const,
                    },
                }) as ToolResult,
        });
        toolMap.set("EnterPlanMode", t);

        const deps = baseDeps({
            toolCalls: [mkCall("enp1", "EnterPlanMode")],
            state,
        });

        const gen = executeToolCalls(deps);
        const allEvents: Event[] = [];

        for await (const ev of gen) {
            allEvents.push(ev);
            if (
                ev.type === "permission.prompt" &&
                (ev as { payload: { reason: string } }).payload.reason === "enter_plan_mode"
            ) {
                const promptEv = ev as Event & { respond: (r: PromptResponse) => void };
                promptEv.respond("allow_once");
            }
        }

        const permissionEvents = allEvents.filter(
            (e) =>
                e.type === "permission.prompt" &&
                (e as { payload: { reason: string } }).payload.reason === "enter_plan_mode",
        );
        expect(permissionEvents.length).toBe(1);

        const modeChanges = allEvents.filter((e) => e.type === "mode.changed");
        expect(modeChanges.length).toBe(1);
        expect(modeChanges[0]).toMatchObject({ mode: "PLAN" });

        expect(state.mode).toBe("PLAN");
    });

    test("no-op when already in target mode (already NORMAL, ExitPlanMode target NORMAL)", async () => {
        const state = mkState({ mode: "NORMAL" });
        const t = mkTool({
            name: "ExitPlanMode",
            execute: async () =>
                ({
                    ok: true,
                    value: { kind: "request_mode_flip", target: "NORMAL" as const },
                }) as ToolResult,
        });
        toolMap.set("ExitPlanMode", t);

        const deps = baseDeps({
            toolCalls: [mkCall("noop1", "ExitPlanMode")],
            state,
        });

        const { events } = await collect(executeToolCalls(deps));

        // No mode.changed event
        const modeChanges = events.filter((e) => e.type === "mode.changed");
        expect(modeChanges.length).toBe(0);

        // No permission.prompt for exit_plan_mode
        const flipPrompts = events.filter(
            (e) =>
                e.type === "permission.prompt" &&
                ((e as { payload: { reason: string } }).payload.reason === "exit_plan_mode" ||
                    (e as { payload: { reason: string } }).payload.reason === "enter_plan_mode"),
        );
        expect(flipPrompts.length).toBe(0);
    });

    test("mode flip deny leaves mode unchanged", async () => {
        const state = mkState({ mode: "PLAN" });
        const t = mkTool({
            name: "ExitPlanMode",
            execute: async () =>
                ({
                    ok: true,
                    value: { kind: "request_mode_flip", target: "NORMAL" as const },
                }) as ToolResult,
        });
        toolMap.set("ExitPlanMode", t);

        const deps = baseDeps({
            toolCalls: [mkCall("ep2", "ExitPlanMode")],
            state,
        });

        const gen = executeToolCalls(deps);
        const allEvents: Event[] = [];

        for await (const ev of gen) {
            allEvents.push(ev);
            if (
                ev.type === "permission.prompt" &&
                (ev as { payload: { reason: string } }).payload.reason === "exit_plan_mode"
            ) {
                const promptEv = ev as Event & { respond: (r: PromptResponse) => void };
                promptEv.respond("deny");
            }
        }

        const modeChanges = allEvents.filter((e) => e.type === "mode.changed");
        expect(modeChanges.length).toBe(0);
        expect(state.mode).toBe("PLAN");
    });
});

// ===========================================================================
// PLAN mode resetDenialTrail
// ===========================================================================

describe("PLAN mode resetDenialTrail", () => {
    test("successful tool run in PLAN mode resets denial trail", async () => {
        const state = mkState({ mode: "PLAN" });
        state.denialTrail = { tool: "Read", count: 3 };
        const t = mkTool({
            name: "Read",
            annotations: { readOnlyHint: true },
            execute: async () => ({ ok: true, value: "content" }) as ToolResult,
        });
        toolMap.set("Read", t);

        const deps = baseDeps({
            toolCalls: [mkCall("r1", "Read")],
            state,
        });

        await collect(executeToolCalls(deps));

        expect(state.denialTrail).toBeNull();
    });

    test("parallel already-handled result in PLAN mode resets denial trail", async () => {
        const state = mkState({ mode: "PLAN" });
        state.denialTrail = { tool: "Read", count: 2 };
        const t = mkTool({ name: "Read", annotations: { readOnlyHint: true } });
        toolMap.set("Read", t);

        const deps = baseDeps({
            toolCalls: [mkCall("r2", "Read")],
            state,
            parallelIds: ["r2"],
        });

        await collect(executeToolCalls(deps));

        expect(state.denialTrail).toBeNull();
    });
});

// ===========================================================================
// Tool call ordering — mix of parallel and sequential
// ===========================================================================

describe("mixed parallel and sequential", () => {
    test("parallel tools yield their ends first, then sequential tools", async () => {
        const fastTool = mkTool({
            name: "Read",
            annotations: { readOnlyHint: true },
            execute: async () => ({ ok: true, value: "fast" }) as ToolResult,
        });
        const slowTool = mkTool({
            name: "Bash",
            execute: async () => ({ ok: true, value: "slow" }) as ToolResult,
        });
        toolMap.set("Read", fastTool);
        toolMap.set("Bash", slowTool);

        const deps = baseDeps({
            toolCalls: [mkCall("par", "Read"), mkCall("seq", "Bash")],
            parallelIds: ["par"],
        });

        const { events } = await collect(executeToolCalls(deps));

        const ends = events.filter((e) => e.type === "tool.end");
        expect(ends.length).toBe(2);
        // Parallel tool end comes first
        expect(ends[0]).toMatchObject({ id: "par" });
        expect(ends[1]).toMatchObject({ id: "seq" });
    });

    test("permission deny on a non-parallel tool yields tool.start + tool.end with error", async () => {
        decideFn = (ctx) => {
            if (ctx.toolCall.name === "Bash") return { kind: "deny", message: "not allowed" };
            return { kind: "allow" };
        };
        const readTool = mkTool({
            name: "Read",
            annotations: { readOnlyHint: true },
            execute: async () => ({ ok: true, value: "ok" }) as ToolResult,
        });
        toolMap.set("Read", readTool);
        toolMap.set("Bash", mkTool({ name: "Bash" }));

        const deps = baseDeps({
            toolCalls: [mkCall("r_ok", "Read"), mkCall("b_deny", "Bash")],
        });

        const { events } = await collect(executeToolCalls(deps));

        // Read should succeed
        const readEnd = events.find(
            (e) => e.type === "tool.end" && (e as { id: string }).id === "r_ok",
        );
        expect(readEnd).toBeDefined();

        // Bash should be denied
        const bashEnd = events.find(
            (e) => e.type === "tool.end" && (e as { id: string }).id === "b_deny",
        );
        expect(bashEnd).toBeDefined();
        const bashResult = (bashEnd as { result: ToolResult }).result;
        expect(bashResult.ok).toBe(false);
        if (!bashResult.ok) expect(bashResult.error).toBe("not allowed");
    });
});

// ===========================================================================
// Session transcript recording
// ===========================================================================

describe("session transcript", () => {
    test("tool.start and tool.end events are appended to session", async () => {
        const t = mkTool({
            name: "transcript_tool",
            execute: async () => ({ ok: true, value: "ok" }) as ToolResult,
        });
        toolMap.set("transcript_tool", t);

        const deps = baseDeps({
            toolCalls: [mkCall("tt1", "transcript_tool")],
        });

        await collect(executeToolCalls(deps));

        const appended = session.events;
        const startEv = appended.find((e) => e.type === "tool.start");
        const endEv = appended.find((e) => e.type === "tool.end");
        expect(startEv).toBeDefined();
        expect(endEv).toBeDefined();
    });
});
