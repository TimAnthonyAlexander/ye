import type { LoadResult } from "../config/index.ts";
import { runEventHooks } from "../hooks/index.ts";
import { getProjectId, openSession, type SessionHandle } from "../storage/index.ts";
import { getProvider, isMissingKeyError } from "../providers/index.ts";
import { destroyBackgroundManager } from "../tools/bash/background.ts";
import { destroyBackgroundSubagentManager } from "../subagents/background.ts";
import {
    anyBackgroundRunning,
    waitForAnyBackgroundCompletion,
    WAKEUP_REMINDERS,
    type BackgroundKind,
} from "./backgroundWakeup.ts";
import { queryLoop } from "./index.ts";
import type { SessionState } from "./state.ts";

// Backstop so a subagent that keeps spawning background work can't pin a
// headless run open forever.
const MAX_HEADLESS_WAKEUPS = 50;

export const runHeadless = async (config: LoadResult, prompt: string): Promise<void> => {
    const cfg = config.config;
    const providerId = cfg.defaultProvider;
    const provider = (() => {
        try {
            return getProvider(cfg);
        } catch (e) {
            if (isMissingKeyError(e)) {
                const provCfg = cfg.providers[providerId];
                const envVar = provCfg?.apiKeyEnv ?? "API key";
                process.stderr.write(
                    `ye: ${envVar} is not set. Set it or add an apiKey to ~/.ye/config.json.\n`,
                );
                process.exit(1);
            }
            throw e;
        }
    })();

    const proj = await getProjectId();
    const session: SessionHandle = await openSession(proj.id);

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
        history: [],
        sessionRules: [],
        denialTrail: null,
        compactedThisTurn: false,
        headless: true,
        shapingFlags: {
            snip: false,
            microcompact: false,
            contextCollapse: false,
            autoCompact: false,
        },
        globalTurnIndex: 0,
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
        process.stderr.write(
            `ye: UserPromptSubmit hook blocked: ${promptHook.reason ?? "unknown"}\n`,
        );
        process.exit(1);
    }
    if (promptHook.context && promptHook.context.length > 0) {
        expanded = `${promptHook.context}\n\n${expanded}`;
    }

    let hadError = false;

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
            switch (evt.type) {
                case "model.text":
                    process.stdout.write(evt.delta);
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
                    if (evt.stopReason === "error" && evt.error) {
                        process.stderr.write(`\nye: ${evt.error.message}\n`);
                        hadError = true;
                    }
                    if (evt.stopReason === "budget_exhausted") {
                        process.stderr.write(`\nye: ${evt.message ?? "budget cap reached"}\n`);
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
    } finally {
        // Kills any still-running background shell command or subagent, so
        // nothing outlives the process.
        destroyBackgroundManager(state.sessionId);
        destroyBackgroundSubagentManager(state.sessionId);
        await session.close();
    }

    process.stdout.write("\n");
    if (hadError) process.exit(1);
};
