import type { LoadResult } from "../config/index.ts";
import { runEventHooks } from "../hooks/index.ts";
import { getProjectId, openSession, type SessionHandle } from "../storage/index.ts";
import { getProvider, isMissingKeyError } from "../providers/index.ts";
import { queryLoop } from "./index.ts";
import type { SessionState } from "./state.ts";

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

    const stream = queryLoop({
        provider,
        config: cfg,
        state,
        session,
        userPrompt: expanded,
        signal,
    });

    let hadError = false;
    try {
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
                    break;
                case "permission.prompt":
                    evt.respond("deny");
                    break;
                case "userQuestion.prompt":
                    evt.respond("yes");
                    break;
            }
        }
    } finally {
        await session.close();
    }

    process.stdout.write("\n");
    if (hadError) process.exit(1);
};
