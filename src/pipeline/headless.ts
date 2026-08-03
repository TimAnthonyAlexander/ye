import {
    emptyRunUsage,
    writeStreamEvent,
    writeSummary,
    type OutputFormat,
    type RunSummary,
    type RunUsage,
} from "../cli/output.ts";
import type { ResumeTarget } from "../cli/resume.ts";
import type { LoadResult } from "../config/index.ts";
import { runEventHooks } from "../hooks/index.ts";
import { restoredSessionRules } from "../permissions/index.ts";
import {
    getProjectId,
    openExistingSession,
    openSession,
    replaySessionFile,
    type SessionHandle,
} from "../storage/index.ts";
import { loadSessionUsage } from "../storage/usage.ts";
import { getProvider, isMissingKeyError, type Provider } from "../providers/index.ts";
import { destroyBackgroundManager } from "../tools/bash/background.ts";
import { destroyBackgroundSubagentManager } from "../subagents/background.ts";
import { destroyMonitorManager } from "../monitors/index.ts";
import {
    anyBackgroundRunning,
    waitForAnyBackgroundCompletion,
    WAKEUP_REMINDERS,
    type BackgroundKind,
} from "./backgroundWakeup.ts";
import type { StopReason } from "./events.ts";
import { queryLoop } from "./index.ts";
import type { SessionState } from "./state.ts";

// Backstop so a subagent that keeps spawning background work can't pin a
// headless run open forever.
const MAX_HEADLESS_WAKEUPS = 50;

export const runHeadless = async (
    config: LoadResult,
    prompt: string,
    format: OutputFormat = "text",
    resume: ResumeTarget | null = null,
): Promise<void> => {
    const startedAt = Date.now();
    const cfg = config.config;
    const providerId = cfg.defaultProvider;
    const model = cfg.defaultModel.model;

    let sessionId = "";
    let projectId = "";
    let turns = 0;
    let turnText = "";
    let result = "";
    let stopReason: StopReason = "end_turn";
    let errorMessage: string | null = null;
    let hadError = false;

    const summarise = async (): Promise<RunSummary> => {
        let usage: RunUsage = emptyRunUsage();
        if (sessionId.length > 0) {
            const totals = (await loadSessionUsage(sessionId)).totals;
            usage = {
                inputTokens: totals.inputTokens,
                outputTokens: totals.outputTokens,
                cachedTokens: totals.cacheReadTokens + totals.cacheCreationTokens,
                costUsd: totals.costUsd,
            };
        }
        return {
            ok: !hadError,
            result,
            stopReason,
            sessionId,
            projectId,
            model,
            provider: providerId,
            turns,
            usage,
            durationMs: Date.now() - startedAt,
            ...(errorMessage !== null ? { error: errorMessage } : {}),
        };
    };

    const finish = async (code: number): Promise<never> => {
        await writeSummary(format, await summarise());
        process.exit(code);
    };

    const fail = async (message: string): Promise<never> => {
        process.stderr.write(`ye: ${message}\n`);
        hadError = true;
        stopReason = "error";
        errorMessage = message;
        return finish(1);
    };

    let provider: Provider;
    try {
        provider = getProvider(cfg);
    } catch (e) {
        if (isMissingKeyError(e)) {
            const provCfg = cfg.providers[providerId];
            const envVar = provCfg?.apiKeyEnv ?? "API key";
            await fail(`${envVar} is not set. Set it or add an apiKey to ~/.ye/config.json.`);
        }
        throw e;
    }

    const proj = await getProjectId();
    projectId = proj.id;
    const replayed = resume === null ? null : await replaySessionFile(resume.path);
    const session: SessionHandle =
        resume === null
            ? await openSession(proj.id)
            : await openExistingSession(proj.id, resume.sessionId);
    sessionId = session.sessionId;

    let contextWindow = 128_000;
    try {
        contextWindow = await provider.getContextSize(cfg.defaultModel.model);
    } catch {
        // keep fallback
    }

    const state: SessionState = {
        sessionId: session.sessionId,
        projectId: proj.id,
        projectRoot: proj.root,
        mode: "AUTO",
        contextWindow,
        history: replayed === null ? [] : [...replayed.history],
        sessionRules: replayed === null ? [] : restoredSessionRules(cfg, replayed.sessionRules),
        denialTrail: null,
        compactedThisTurn: false,
        headless: true,
        shapingFlags: {
            snip: false,
            microcompact: false,
            contextCollapse: false,
            autoCompact: false,
        },
        globalTurnIndex: replayed?.maxGlobalTurnIndex ?? 0,
        selectedMemory: null,
        turnState: { readFiles: new Map(), todos: [] },
    };

    const signal = new AbortController().signal;

    void runEventHooks(cfg.hooks, "SessionStart", { project_dir: proj.root }, signal);

    let expanded = prompt;
    const promptHook = await runEventHooks(
        cfg.hooks,
        "UserPromptSubmit",
        { prompt, project_dir: proj.root },
        signal,
    );
    if (promptHook.blocked) {
        await session.close();
        await fail(`UserPromptSubmit hook blocked: ${promptHook.reason ?? "unknown"}`);
    }
    if (promptHook.context && promptHook.context.length > 0) {
        expanded = `${promptHook.context}\n\n${expanded}`;
    }

    const drain = async (prompt: string): Promise<void> => {
        const stream = queryLoop({
            provider,
            config: cfg,
            state,
            session,
            userPrompt: prompt,
            signal,
        });
        for await (const evt of stream) {
            if (format === "stream-json") writeStreamEvent(evt);
            switch (evt.type) {
                case "turn.start":
                    turns += 1;
                    turnText = "";
                    break;
                case "model.text":
                    if (format === "text") process.stdout.write(evt.delta);
                    else turnText += evt.delta;
                    break;
                case "model.reasoning":
                    break;
                case "tool.start":
                    process.stderr.write(`\n[tool: ${evt.name}]\n`);
                    break;
                case "shaper.applied":
                    process.stderr.write(`[${evt.name}: freed ~${evt.tokensFreed} tokens]\n`);
                    break;
                case "turn.end":
                    if (turnText.trim().length > 0) result = turnText;
                    stopReason = evt.stopReason;
                    if (evt.stopReason === "error" && evt.error) {
                        process.stderr.write(`\nye: ${evt.error.message}\n`);
                        errorMessage = evt.error.message;
                        hadError = true;
                    }
                    if (evt.stopReason === "budget_exhausted") {
                        const message = evt.message ?? "budget cap reached";
                        process.stderr.write(`\nye: ${message}\n`);
                        errorMessage = message;
                        hadError = true;
                    }
                    break;
                case "permission.prompt":
                    evt.respond("deny");
                    break;
                case "userQuestion.prompt":
                    evt.respond("yes");
                    break;
            }
        }
    };

    try {
        await drain(expanded);

        // Background work is async by default (Task) or opt-in (Bash), and the
        // model is told to end its turn and wait for the wakeup. Headless has no
        // UI loop to deliver that wakeup, so without this the process would exit
        // the moment the model stopped talking and every background result —
        // including the entire output of a backgrounded subagent — would be
        // silently discarded. Keep pumping turns while work is outstanding.
        let wakeups = 0;
        while (anyBackgroundRunning(state.sessionId) && wakeups < MAX_HEADLESS_WAKEUPS) {
            let kind: BackgroundKind;
            try {
                kind = await waitForAnyBackgroundCompletion(state.sessionId, signal);
            } catch {
                break;
            }
            wakeups += 1;
            await drain(WAKEUP_REMINDERS[kind]);
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        process.stderr.write(`\nye: ${message}\n`);
        errorMessage = message;
        stopReason = "error";
        hadError = true;
    } finally {
        // Kills any still-running background shell command, subagent or
        // monitor, so nothing outlives the process.
        destroyBackgroundManager(state.sessionId);
        destroyBackgroundSubagentManager(state.sessionId);
        destroyMonitorManager(state.sessionId);
        await session.close();
    }

    if (format === "text") process.stdout.write("\n");
    await finish(hadError ? 1 : 0);
};
