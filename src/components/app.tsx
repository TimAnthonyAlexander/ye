import { Box, Text, useApp, useInput } from "ink";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import pkg from "../../package.json" with { type: "json" };
import {
    completeCommand,
    dispatch,
    parseSlash,
    setExtraCommands,
    type PickerPayload,
    type SlashCommandContext,
} from "../commands/index.ts";
import {
    buildSkillToolDescription,
    loadSkillRegistry,
    skillToSlashCommand,
} from "../skills/index.ts";
import { setSkillRegistry } from "../tools/skill/index.ts";
import {
    expandMentions,
    type ExpandedAttachment,
    findActiveMention,
    type IndexEntry,
    loadFileIndex,
    matchFiles,
    type MentionOption,
} from "../mentions/index.ts";
import { type Config, type LoadResult, type PermissionMode, saveConfig } from "../config/index.ts";
import type { PermissionPromptPayload, PromptResponse } from "../permissions/index.ts";
import { createSessionState, queryLoop, type SessionState } from "../pipeline/index.ts";
import { resetShapingFlags } from "../pipeline/state.ts";
import type { Message, ToolCallRequest } from "../providers/index.ts";
import type { ReplayedSession } from "../storage/index.ts";
import { estimateTokens } from "../pipeline/shapers/tokens.ts";
import {
    defaultModelFor,
    findModel,
    type KeyPromptPayload,
    type Provider,
    tryBuildProvider,
} from "../providers/index.ts";
import {
    appendHistory,
    generateSessionTitle,
    getProjectId,
    listProjectSessions,
    loadHistory,
    openExistingSession,
    openSession,
    recordSessionTitle,
    replaySessionFile,
    resetTerminalTitle,
    rewindToTurn,
    titleModelFor,
    type SessionHandle,
    type SessionSummary,
    writeTerminalTitle,
} from "../storage/index.ts";
import type { TodoItem } from "../tools/index.ts";
import { cycleMode } from "../ui/keybinds.ts";
import { refreshUpdateStatus, type UpdateStatus } from "../update/check.ts";
import { Chat, type ChatItem, computeDynamicStart, newChatItemId } from "./chat.tsx";
import { ChatInput, type ChatInputHandle } from "./input.tsx";
import { KeyPrompt } from "./keyPrompt.tsx";
import { MentionPicker } from "./mentionPicker.tsx";
import { PermissionPrompt } from "./permissionPrompt.tsx";
import { Picker } from "./picker.tsx";
import { SlashPicker } from "./slashPicker.tsx";
import { StatusBar } from "./statusBar.tsx";
import { TodoPanel } from "./todoPanel.tsx";
import type { ToolCallEntry } from "./toolCall.tsx";
import { UserQuestion, type UserQuestionPayload } from "./userQuestion.tsx";

type QueuedSend =
    | {
          readonly kind: "user";
          readonly id: string;
          readonly text: string;
          readonly expanded: string;
          readonly attachments: readonly ExpandedAttachment[];
      }
    | { readonly kind: "hidden"; readonly prompt: string };

interface QueuedDisplayItem {
    readonly id: string;
    readonly text: string;
}

interface AppProps {
    readonly config: LoadResult;
    // When set, App opens the resume picker (or loads the named session
    // directly) instead of starting a fresh transcript on mount.
    readonly resumeOnStart?: boolean;
    readonly resumeSessionId?: string | null;
}

interface PendingPrompt {
    readonly payload: PermissionPromptPayload;
    readonly respond: (r: PromptResponse) => void;
}

interface PendingUserQuestion {
    readonly payload: UserQuestionPayload;
    readonly respond: (answer: string) => void;
}

interface PendingPicker {
    readonly payload: PickerPayload;
    readonly respond: (id: string | null) => void;
}

interface PendingKeyPrompt {
    readonly payload: KeyPromptPayload;
    readonly respond: (key: string | null) => void;
}

const prettyCwd = (): string => {
    const cwd = process.cwd();
    const home = homedir();
    return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
};

const projectHasNotes = (cwd: string): boolean =>
    existsSync(join(cwd, "CLAUDE.md")) || existsSync(join(cwd, "YE.md"));

const buildWelcomeItem = (cfg: Config): ChatItem | null => {
    const cwd = process.cwd();
    if (projectHasNotes(cwd)) return null;
    let username: string | null = null;
    try {
        const u = userInfo().username;
        username = u.length > 0 ? u : null;
    } catch {
        username = null;
    }
    return {
        kind: "welcome",
        id: newChatItemId(),
        version: pkg.version,
        cwd: prettyCwd(),
        providerId: cfg.defaultProvider,
        model: cfg.defaultModel.model,
        username,
    };
};

const formatElapsed = (totalSec: number): string => {
    if (totalSec < 60) return `${totalSec}s`;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
};

const safeParseArgs = (raw: string): unknown => {
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
};

// Convert a replayed Message[] back into the ChatItem[] the live UI uses.
// Tool messages are skipped — their content is already captured by the tool
// call entry's result. Tool calls inherit ok/error status and result text from
// the replay's parallel toolCalls array (looked up by id).
const buildItemsFromReplay = (replayed: ReplayedSession): ChatItem[] => {
    const items: ChatItem[] = [];
    interface ResultRow {
        readonly ok: boolean;
        readonly text: string;
        readonly args: unknown;
    }
    const resultsById = new Map<string, ResultRow>();
    for (const tc of replayed.toolCalls) {
        resultsById.set(tc.id, { ok: tc.resultOk, text: tc.resultText, args: tc.args });
    }

    for (const msg of replayed.history as readonly Message[]) {
        if (msg.role === "user" && typeof msg.content === "string") {
            items.push({
                kind: "message",
                id: newChatItemId(),
                role: "user",
                content: msg.content,
            });
            continue;
        }
        if (msg.role === "assistant") {
            const text = typeof msg.content === "string" ? msg.content : "";
            if (text.length > 0) {
                items.push({
                    kind: "message",
                    id: newChatItemId(),
                    role: "assistant",
                    content: text,
                });
            }
            for (const tc of (msg.tool_calls ?? []) as readonly ToolCallRequest[]) {
                const row = resultsById.get(tc.id);
                const args = row?.args ?? safeParseArgs(tc.function.arguments);
                items.push({
                    kind: "toolCall",
                    entry: {
                        id: tc.id,
                        name: tc.function.name,
                        args,
                        status: row ? (row.ok ? "done" : "error") : "done",
                        ...(row
                            ? {
                                  result: row.ok
                                      ? { ok: true, value: row.text }
                                      : { ok: false, error: row.text },
                              }
                            : {}),
                    },
                });
            }
        }
    }
    return items;
};

export const App = ({ config, resumeOnStart, resumeSessionId }: AppProps) => {
    const initialCfg = config.config;
    const { exit } = useApp();
    const [mode, setMode] = useState<PermissionMode>(
        initialCfg.permissions?.defaultMode ?? "NORMAL",
    );
    const [providerId, setProviderId] = useState<string>(initialCfg.defaultProvider);
    const [model, setModelState] = useState<string>(initialCfg.defaultModel.model);
    const [items, setItems] = useState<ChatItem[]>(() => {
        const welcome = buildWelcomeItem(initialCfg);
        return welcome ? [welcome] : [];
    });
    const [streamingText, setStreamingText] = useState("");
    const [streaming, setStreaming] = useState(false);
    const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
    const [pendingUserQuestion, setPendingUserQuestion] = useState<PendingUserQuestion | null>(
        null,
    );
    const [pendingPicker, setPendingPicker] = useState<PendingPicker | null>(null);
    const [pendingKeyPrompt, setPendingKeyPrompt] = useState<PendingKeyPrompt | null>(null);
    const [todos, setTodos] = useState<readonly TodoItem[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [bootError, setBootError] = useState<string | null>(null);
    const [currentInput, setCurrentInput] = useState("");
    const [currentCursor, setCurrentCursor] = useState(0);
    const [fileIndex, setFileIndex] = useState<readonly IndexEntry[]>([]);
    const [mentionActive, setMentionActive] = useState(0);
    // When set, the picker is suppressed for this exact query string until the
    // user edits the mention (causing the query to change) — that's how Esc
    // closes the picker without preventing it from reopening on `@`.
    const [dismissedMentionQuery, setDismissedMentionQuery] = useState<string | null>(null);
    // Index up to which `items` has been committed to Ink's <Static>
    // (scrollback). Advanced eagerly via useLayoutEffect below — every
    // stable, non-trailing-mergeable item is committed as soon as it
    // settles. Anything still in the live region re-renders on every
    // animation frame; keeping that region small is what prevents Ink from
    // falling back to clearTerminal-based redraws on a tall conversation.
    const [committedCount, setCommittedCount] = useState(items.length);
    // Bumped whenever items are replaced wholesale (rotateSession, loadSession,
    // runRewindFlow). Used as a key on <Chat> to force a remount — Ink's
    // <Static> is append-only and won't re-emit items it has previously sent
    // to scrollback, so after a terminal clear we need a fresh Static to
    // reprint the new history.
    const [chatKey, setChatKey] = useState(0);
    const bumpChatKey = (): void => setChatKey((k) => k + 1);
    // Toggled with Ctrl+O. Only affects groups in the dynamic section —
    // anything in scrollback already committed in collapsed form.
    const [groupsExpanded, setGroupsExpanded] = useState(false);
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

    const stateRef = useRef<SessionState | null>(null);
    const sessionRef = useRef<SessionHandle | null>(null);
    const providerRef = useRef<Provider | null>(null);
    // True once a session.title has been generated (or restored from a
    // resumed session). Gates the one-shot title generator so the second user
    // message doesn't fire a fresh title call.
    const titleGeneratedRef = useRef(false);
    // Mutable, in-memory mirror of the on-disk config. tryBuildProvider returns
    // an updated cfg when a key is persisted; we write it here so subsequent
    // builds and queryLoop calls see the new key without a stale closure.
    const cfgRef = useRef<Config>(initialCfg);
    const pendingTodosRef = useRef<readonly TodoItem[] | null>(null);
    const streamingRef = useRef(false);
    const queueRef = useRef<QueuedSend[]>([]);
    const abortRef = useRef<AbortController | null>(null);
    const chatInputRef = useRef<ChatInputHandle | null>(null);
    // Track total work time across a chain of queued sends so the
    // "Worked for Xs" message reflects the full hand-off duration, not just
    // the final turn.
    const chainStartRef = useRef<number | null>(null);
    const chainFailedRef = useRef(false);
    const [queuedCount, setQueuedCount] = useState(0);
    // Pending user messages waiting for the in-flight turn to finish. Kept out
    // of `items` so streaming output doesn't push them up the scrollback —
    // they're rendered in a pinned panel above the input until drained.
    const [queuedDisplay, setQueuedDisplay] = useState<readonly QueuedDisplayItem[]>([]);
    const [usedTokens, setUsedTokens] = useState(0);
    const [contextWindow, setContextWindow] = useState(0);
    const [history, setHistory] = useState<readonly string[]>([]);
    // Mirror of `history` so send() can dedup against the most-recent entry
    // without re-rendering on every read.
    const historyRef = useRef<readonly string[]>([]);
    // Recompute the commit boundary synchronously after each render that
    // changes items or streaming, before Ink writes to the terminal. This is
    // why we use useLayoutEffect rather than useEffect: a useEffect runs
    // after Ink's stdout flush, which would briefly draw the just-completed
    // tool call inside the live region before promoting it to <Static> on
    // the next frame — exactly the kind of one-frame artifact we're trying
    // to eliminate. Math.max enforces monotonicity since <Static> is
    // append-only; the boundary is reset to 0 explicitly in rotateSession.
    useLayoutEffect(() => {
        const target = streaming ? computeDynamicStart(items) : items.length;
        setCommittedCount((prev) => (target > prev ? target : prev));
    }, [items, streaming]);

    useEffect(() => {
        let cancelled = false;
        loadHistory()
            .then((entries) => {
                if (cancelled) return;
                historyRef.current = entries;
                setHistory(entries);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, []);

    const recordHistory = (text: string): void => {
        if (historyRef.current[0] === text) return;
        const next = [text, ...historyRef.current];
        historyRef.current = next;
        setHistory(next);
        appendHistory(text).catch(() => {});
    };

    const addSystemMessage = (text: string): void => {
        setItems((prev) => [...prev, { kind: "system", id: newChatItemId(), content: text }]);
    };

    const syncQueueDisplay = (): void => {
        setQueuedCount(queueRef.current.length);
        setQueuedDisplay(
            queueRef.current
                .filter((q): q is Extract<QueuedSend, { kind: "user" }> => q.kind === "user")
                .map((q) => ({ id: q.id, text: q.text })),
        );
    };

    const appendUserToChat = (text: string, attachments: readonly ExpandedAttachment[]): void => {
        const userItem: ChatItem = {
            kind: "message",
            id: newChatItemId(),
            role: "user",
            content: text,
        };
        if (attachments.length === 0) {
            setItems((prev) => [...prev, userItem]);
            return;
        }
        const readItems: ChatItem[] = attachments.map((a) => ({
            kind: "toolCall",
            entry: {
                id: newChatItemId(),
                name: "Read",
                args: { path: a.abs },
                status: "done",
                result: { ok: true, value: "" },
            },
        }));
        setItems((prev) => [...prev, userItem, ...readItems]);
    };

    const rotateSession = async (): Promise<void> => {
        const state = stateRef.current;
        if (!state) return;
        const oldSession = sessionRef.current;
        const newSession = await openSession(state.projectId);
        sessionRef.current = newSession;
        if (oldSession) await oldSession.close().catch(() => {});
        state.history = [];
        state.sessionRules = [];
        state.denialTrail = null;
        state.compactedThisTurn = false;
        resetShapingFlags(state);
        setItems([]);
        setCommittedCount(0);
        setTodos([]);
        setError(null);
        setUsedTokens(0);
        titleGeneratedRef.current = false;
        resetTerminalTitle();
        bumpChatKey();
        // Items already promoted to <Static> live in terminal scrollback,
        // outside React's tree — clearing items state alone won't reclaim
        // those rows. ESC[2J clears the visible screen, ESC[3J the scrollback.
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    };

    // Fire-and-forget: generate a 2-5 word session title from the first user
    // message using a small/cheap model on the active provider, persist it as
    // a session.title event, and push it to the terminal/tmux pane.
    // Failures (no cheap model registered, network blip, model refused) are
    // swallowed silently — the session falls back to its first-message
    // preview in the resume picker.
    const triggerTitleGeneration = (userPrompt: string): void => {
        if (titleGeneratedRef.current) return;
        const provider = providerRef.current;
        const session = sessionRef.current;
        if (!provider || !session) return;
        const model = titleModelFor(provider.id);
        if (!model) return;
        titleGeneratedRef.current = true;
        void (async () => {
            try {
                const title = await generateSessionTitle({
                    provider,
                    model,
                    userPrompt,
                });
                if (!title) {
                    titleGeneratedRef.current = false;
                    return;
                }
                if (sessionRef.current === session) {
                    await recordSessionTitle({ session, title });
                    writeTerminalTitle(title);
                }
            } catch {
                titleGeneratedRef.current = false;
            }
        })();
    };

    // Resume an existing session: replay its JSONL into history, swap the
    // session handle to append-mode against the same file, and rebuild the
    // chat view. Permissions are NOT restored — the user re-prompts on the
    // first state-modifying call (PERMISSIONS.md hard rule).
    const loadSession = async (sessionId: string): Promise<void> => {
        const state = stateRef.current;
        if (!state) throw new Error("session not ready");
        const summaries = await listProjectSessions(state.projectId);
        const summary = summaries.find((s) => s.sessionId === sessionId);
        if (!summary) throw new Error(`session not found: ${sessionId}`);

        const replayed = await replaySessionFile(summary.path);
        const newSession = await openExistingSession(state.projectId, sessionId);
        const oldSession = sessionRef.current;
        sessionRef.current = newSession;
        if (oldSession) await oldSession.close().catch(() => {});

        state.history = [...(replayed.history as Message[])];
        state.sessionRules = [];
        state.denialTrail = null;
        state.compactedThisTurn = false;
        resetShapingFlags(state);
        // Resume globalTurnIndex from the highest one observed in the JSONL
        // so post-resume edits don't collide with already-written checkpoints.
        state.globalTurnIndex = replayed.maxGlobalTurnIndex;
        if (replayed.mode) {
            state.mode = replayed.mode;
            setMode(replayed.mode);
        }

        const replayItems = buildItemsFromReplay(replayed);
        // Clear BEFORE queueing the state updates. Ink's <Static> writes items
        // to terminal scrollback as React commits them — if we clear afterwards,
        // we wipe the scrollback Ink just emitted, but Ink's internal
        // "already-rendered" state still claims those items were sent. Result:
        // Static refuses to re-emit on subsequent renders and the user sees
        // only the trailing system message ("Session resumed.").
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
        bumpChatKey();
        setItems(replayItems);
        setCommittedCount(replayItems.length);
        setTodos([]);
        setError(null);
        setUsedTokens(estimateTokens(state.history));
        if (replayed.title) {
            titleGeneratedRef.current = true;
            writeTerminalTitle(replayed.title);
        } else {
            titleGeneratedRef.current = false;
            resetTerminalTitle();
        }
    };

    const buildResumeOptions = (
        summaries: readonly SessionSummary[],
    ): readonly { id: string; label: string; description: string }[] =>
        summaries.map((s) => {
            const stamp = s.modifiedAt.slice(0, 16).replace("T", " ");
            const headline = s.title ?? `${s.userMessageCount} msg`;
            return {
                id: s.sessionId,
                label: `${stamp} · ${headline}`,
                description: s.preview || "(no preview)",
            };
        });

    const runResumePicker = async (): Promise<string | null> => {
        const state = stateRef.current;
        if (!state) return null;
        const summaries = await listProjectSessions(state.projectId);
        if (summaries.length === 0) {
            addSystemMessage("No previous sessions to resume.");
            return null;
        }
        return await pick({
            title: "Resume session",
            options: buildResumeOptions(summaries),
        });
    };

    const runRewindFlow = async (): Promise<boolean> => {
        const state = stateRef.current;
        const session = sessionRef.current;
        if (!state || !session) return false;
        const replayed = await replaySessionFile(session.path);
        if (replayed.prompts.length === 0) {
            addSystemMessage("No earlier prompts to rewind to.");
            return false;
        }
        const options = replayed.prompts.map((p) => ({
            id: String(p.ordinal),
            label: `${p.ts.slice(0, 16).replace("T", " ")} · prompt ${p.ordinal + 1}`,
            description: p.preview || "(no preview)",
        }));
        const choice = await pick({ title: "Rewind to before…", options });
        if (!choice) return false;
        const ordinal = Number.parseInt(choice, 10);
        const target = replayed.prompts[ordinal];
        if (!target) return false;

        await rewindToTurn(state.projectId, state.sessionId, target.firstTurnGlobalIdx);
        await session.appendEvent({
            type: "rewind",
            upToPrompt: target.ordinal,
            firstTurnGlobalIdx: target.firstTurnGlobalIdx,
        });

        // Truncate in-memory state to before the chosen prompt's user message.
        state.history = state.history.slice(0, target.historyIdx);
        state.sessionRules = [];
        state.denialTrail = null;
        state.compactedThisTurn = false;
        resetShapingFlags(state);

        // Replace UI items with the post-truncation projection. Easiest path:
        // re-replay the JSONL (which now has the rewind marker we just wrote)
        // and rebuild items from scratch.
        const after = await replaySessionFile(session.path);
        const newItems = buildItemsFromReplay(after);
        // Clear before queueing state updates — see loadSession for why.
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
        bumpChatKey();
        setItems(newItems);
        setCommittedCount(newItems.length);
        setTodos([]);
        setError(null);
        setUsedTokens(estimateTokens(state.history));
        return true;
    };

    const askForKey = (payload: KeyPromptPayload): Promise<string | null> => {
        return new Promise<string | null>((resolve) => {
            setPendingKeyPrompt({
                payload,
                respond: (key) => {
                    setPendingKeyPrompt(null);
                    resolve(key);
                },
            });
        });
    };

    const switchProvider = async (nextId: string): Promise<void> => {
        const state = stateRef.current;
        if (!state) throw new Error("session not ready");
        const built = await tryBuildProvider({
            cfg: cfgRef.current,
            providerId: nextId,
            askForKey,
            persistConfig: saveConfig,
        });
        if (!built) {
            // Cancellation routes through /provider's try/catch, which surfaces
            // the message in the red error bar — visually consistent with other
            // slash-command failures.
            throw new Error(`API key required for ${nextId}; switch cancelled`);
        }
        cfgRef.current = built.cfg;
        const nextModelInfo = defaultModelFor(nextId);
        const nextModel = nextModelInfo?.id ?? built.cfg.defaultModel.model;
        let nextWindow = state.contextWindow;
        try {
            nextWindow = await built.provider.getContextSize(nextModel);
        } catch {
            // Keep prior window on failure — getContextSize already falls back internally.
        }
        providerRef.current = built.provider;
        state.activeModel = nextModel;
        state.contextWindow = nextWindow;
        setProviderId(nextId);
        setModelState(nextModel);
        setContextWindow(nextWindow);
        const nextCfg: Config = {
            ...built.cfg,
            defaultProvider: nextId,
            defaultModel: {
                ...built.cfg.defaultModel,
                provider: nextId,
                model: nextModel,
            },
        };
        cfgRef.current = nextCfg;
        await saveConfig(nextCfg);
    };

    const switchModel = async (nextModel: string): Promise<void> => {
        const state = stateRef.current;
        const provider = providerRef.current;
        if (!state || !provider) throw new Error("session not ready");
        let nextWindow = state.contextWindow;
        try {
            nextWindow = await provider.getContextSize(nextModel);
        } catch {
            // Keep prior window on failure.
        }
        state.activeModel = nextModel;
        state.contextWindow = nextWindow;
        setModelState(nextModel);
        setContextWindow(nextWindow);
        const nextCfg: Config = {
            ...cfgRef.current,
            defaultModel: {
                ...cfgRef.current.defaultModel,
                provider: providerId,
                model: nextModel,
            },
        };
        cfgRef.current = nextCfg;
        await saveConfig(nextCfg);
    };

    const pick = (payload: PickerPayload): Promise<string | null> => {
        return new Promise<string | null>((resolve) => {
            setPendingPicker({
                payload,
                respond: (id) => {
                    setPendingPicker(null);
                    resolve(id);
                },
            });
        });
    };

    const runSlash = async (text: string): Promise<void> => {
        const parsed = parseSlash(text);
        if (!parsed) return;
        const state = stateRef.current;
        if (!state) {
            setError("session not ready");
            return;
        }
        setItems((prev) => [
            ...prev,
            { kind: "message", id: newChatItemId(), role: "user", content: text },
        ]);
        const ctx: SlashCommandContext = {
            cwd: process.cwd(),
            projectRoot: state.projectRoot,
            projectId: state.projectId,
            mode: state.mode,
            providerId,
            model,
            setMode: (next) => {
                state.mode = next;
                state.denialTrail = null;
                setMode(next);
                sessionRef.current
                    ?.appendEvent({ type: "mode.changed", mode: next })
                    .catch(() => {});
            },
            setProvider: switchProvider,
            setModel: switchModel,
            clearChat: rotateSession,
            resume: async () => {
                const targetId = await runResumePicker();
                if (!targetId) return false;
                await loadSession(targetId);
                return true;
            },
            rewind: runRewindFlow,
            exitApp: exit,
            addSystemMessage,
            sendHiddenPrompt,
            getLastAssistantText: () => {
                const history = stateRef.current?.history ?? [];
                for (let i = history.length - 1; i >= 0; i--) {
                    const msg = history[i];
                    if (msg && msg.role === "assistant" && msg.content !== null) {
                        const trimmed = msg.content.trim();
                        if (trimmed.length > 0) return msg.content;
                    }
                }
                return null;
            },
            pick,
        };
        const result = await dispatch(parsed, ctx);
        if (result.kind === "error") {
            setError(result.message);
        }
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const built = await tryBuildProvider({
                    cfg: cfgRef.current,
                    providerId: cfgRef.current.defaultProvider,
                    askForKey,
                    persistConfig: saveConfig,
                });
                if (cancelled) return;
                if (!built) {
                    const env = cfgRef.current.providers[cfgRef.current.defaultProvider]?.apiKeyEnv;
                    setBootError(
                        env
                            ? `API key required. Set $${env} and relaunch, or relaunch to enter one.`
                            : "API key required to start.",
                    );
                    return;
                }
                cfgRef.current = built.cfg;
                const proj = await getProjectId();
                const { state, session } = await createSessionState({
                    provider: built.provider,
                    config: built.cfg,
                    projectId: proj.id,
                    projectRoot: proj.root,
                });
                if (cancelled) {
                    await session.close();
                    return;
                }
                providerRef.current = built.provider;
                stateRef.current = state;
                sessionRef.current = session;
                setMode(state.mode);
                setContextWindow(state.contextWindow);
                setUsedTokens(estimateTokens(state.history));
                loadFileIndex(state.projectRoot)
                    .then((idx) => {
                        if (!cancelled) setFileIndex(idx);
                    })
                    .catch(() => {});
                loadSkillRegistry({
                    projectRoot: state.projectRoot,
                    enableClaudeInterop: cfgRef.current.skills?.enableClaudeInterop === true,
                })
                    .then((registry) => {
                        if (cancelled) return;
                        setSkillRegistry(registry, buildSkillToolDescription(registry));
                        setExtraCommands(registry.slashBound.map(skillToSlashCommand));
                    })
                    .catch(() => {});

                if (resumeOnStart) {
                    try {
                        const targetId = resumeSessionId
                            ? resumeSessionId
                            : await runResumePicker();
                        if (!cancelled && targetId) await loadSession(targetId);
                    } catch (e) {
                        if (!cancelled) {
                            setError(
                                `resume failed: ${e instanceof Error ? e.message : String(e)}`,
                            );
                        }
                    }
                }
            } catch (e) {
                setBootError(e instanceof Error ? e.message : String(e));
            }
        })();
        return () => {
            cancelled = true;
            sessionRef.current?.close().catch(() => {});
        };
        // The config prop never changes for the lifetime of App (cli.tsx mounts
        // once); cfgRef is mutated in place. eslint-disable-next-line is
        // intentional — depending on `config` triggers a remount with the
        // initial config and would lose persisted keys.
    }, [config]);

    useInput((input, key) => {
        if (key.ctrl && input === "c") {
            // Ctrl+C: clear input → abort stream → no-op. Use /exit to quit.
            if (currentInput.length > 0) {
                chatInputRef.current?.clear();
                return;
            }
            if (streamingRef.current && abortRef.current) {
                abortRef.current.abort();
                queueRef.current = [];
                syncQueueDisplay();
                setItems((prev) => [
                    ...prev,
                    { kind: "system", id: newChatItemId(), content: "(stopped)" },
                ]);
            }
            return;
        }
        if (key.ctrl && input === "o") {
            // Ctrl+O: toggle expansion of grouped read-only tool calls in the
            // dynamic section. Doesn't affect anything already in scrollback.
            setGroupsExpanded((v) => !v);
            return;
        }
        if (
            key.tab &&
            key.shift &&
            stateRef.current &&
            !pendingPrompt &&
            !pendingPicker &&
            !pendingUserQuestion &&
            !pendingKeyPrompt
        ) {
            const next = cycleMode(stateRef.current.mode);
            stateRef.current.mode = next;
            stateRef.current.denialTrail = null;
            setMode(next);
            sessionRef.current?.appendEvent({ type: "mode.changed", mode: next }).catch(() => {});
        }
    });

    const sendNow = async (text: string): Promise<void> => {
        if (chainStartRef.current === null) {
            chainStartRef.current = Date.now();
            chainFailedRef.current = false;
        }
        streamingRef.current = true;
        abortRef.current = new AbortController();
        setStreaming(true);
        setStreamingText("");

        let currentText = "";
        let pendingFlush: ReturnType<typeof setTimeout> | null = null;

        // Coalesce token deltas to one render per frame (~16ms). Prevents the
        // render storm where every streamed token re-rendered the whole tree.
        const scheduleStreamFlush = (): void => {
            if (pendingFlush !== null) return;
            pendingFlush = setTimeout(() => {
                pendingFlush = null;
                setStreamingText(currentText);
            }, 16);
        };

        const cancelPendingFlush = (): void => {
            if (pendingFlush !== null) {
                clearTimeout(pendingFlush);
                pendingFlush = null;
            }
        };

        const commitText = (): void => {
            cancelPendingFlush();
            if (currentText.length === 0) return;
            // Models routinely tack on trailing newlines after their last
            // sentence; those render as extra blank rows above the next item.
            const committed = currentText.replace(/\s+$/, "");
            currentText = "";
            setStreamingText("");
            if (committed.length === 0) return;
            setItems((prev) => [
                ...prev,
                {
                    kind: "message",
                    id: newChatItemId(),
                    role: "assistant",
                    content: committed,
                },
            ]);
        };

        // Reasoning ("thinking") accumulator. Mirrors the text accumulator but
        // owns a live ChatItem that we mutate in place via setItems map. When
        // the model starts emitting visible text or a tool_call we finalize
        // the item to status "done" so it collapses to a one-liner above the
        // streaming text.
        let liveThinking: { id: string; content: string; startedAt: number } | null = null;
        let pendingThinkingFlush: ReturnType<typeof setTimeout> | null = null;

        const scheduleThinkingFlush = (): void => {
            if (pendingThinkingFlush !== null) return;
            pendingThinkingFlush = setTimeout(() => {
                pendingThinkingFlush = null;
                if (!liveThinking) return;
                const { id, content } = liveThinking;
                setItems((prev) =>
                    prev.map((item) =>
                        item.kind === "thinking" && item.id === id ? { ...item, content } : item,
                    ),
                );
            }, 16);
        };

        const cancelThinkingFlush = (): void => {
            if (pendingThinkingFlush !== null) {
                clearTimeout(pendingThinkingFlush);
                pendingThinkingFlush = null;
            }
        };

        const finalizeThinking = (): void => {
            cancelThinkingFlush();
            if (!liveThinking) return;
            const { id, content, startedAt } = liveThinking;
            const elapsedMs = Date.now() - startedAt;
            liveThinking = null;
            setItems((prev) =>
                prev.map((item) =>
                    item.kind === "thinking" && item.id === id
                        ? { ...item, content, status: "done", elapsedMs }
                        : item,
                ),
            );
        };

        try {
            const stream = queryLoop({
                provider: providerRef.current!,
                config: cfgRef.current,
                state: stateRef.current!,
                session: sessionRef.current!,
                userPrompt: text,
                signal: abortRef.current.signal,
            });

            for await (const evt of stream) {
                switch (evt.type) {
                    case "model.reasoning": {
                        if (!liveThinking) {
                            const id = newChatItemId();
                            const startedAt = Date.now();
                            liveThinking = { id, content: "", startedAt };
                            setItems((prev) => [
                                ...prev,
                                {
                                    kind: "thinking",
                                    id,
                                    content: "",
                                    status: "live",
                                    startedAt,
                                },
                            ]);
                        }
                        liveThinking.content += evt.delta;
                        scheduleThinkingFlush();
                        break;
                    }
                    case "model.text": {
                        finalizeThinking();
                        currentText += evt.delta;
                        scheduleStreamFlush();
                        break;
                    }
                    case "model.toolCall": {
                        finalizeThinking();
                        commitText();
                        const entry: ToolCallEntry = {
                            id: evt.id,
                            name: evt.name,
                            args: evt.args,
                            status: "running",
                        };
                        setItems((prev) => [...prev, { kind: "toolCall", entry }]);
                        if (evt.name === "TodoWrite") {
                            const a = evt.args as { todos?: readonly TodoItem[] };
                            if (Array.isArray(a.todos)) pendingTodosRef.current = a.todos;
                        }
                        break;
                    }
                    case "tool.end": {
                        setItems((prev) =>
                            prev.map((item) => {
                                if (item.kind !== "toolCall") return item;
                                if (item.entry.id !== evt.id) return item;
                                return {
                                    kind: "toolCall",
                                    entry: {
                                        ...item.entry,
                                        status: evt.result.ok ? "done" : "error",
                                        result: evt.result,
                                    },
                                };
                            }),
                        );
                        if (evt.name === "TodoWrite" && evt.result.ok && pendingTodosRef.current) {
                            setTodos(pendingTodosRef.current);
                            pendingTodosRef.current = null;
                        }
                        break;
                    }
                    case "tool.progress": {
                        setItems((prev) =>
                            prev.map((item) => {
                                if (item.kind !== "toolCall") return item;
                                if (item.entry.id !== evt.id) return item;
                                return {
                                    kind: "toolCall",
                                    entry: { ...item.entry, progress: evt.lines },
                                };
                            }),
                        );
                        break;
                    }
                    case "permission.prompt": {
                        await new Promise<void>((resolve) => {
                            setPendingPrompt({
                                payload: evt.payload,
                                respond: (decision) => {
                                    evt.respond(decision);
                                    setPendingPrompt(null);
                                    resolve();
                                },
                            });
                        });
                        break;
                    }
                    case "userQuestion.prompt": {
                        await new Promise<void>((resolve) => {
                            setPendingUserQuestion({
                                payload: evt.payload,
                                respond: (answer) => {
                                    evt.respond(answer);
                                    setPendingUserQuestion(null);
                                    resolve();
                                },
                            });
                        });
                        break;
                    }
                    case "mode.changed": {
                        setMode(evt.mode as PermissionMode);
                        break;
                    }
                    case "turn.end": {
                        finalizeThinking();
                        commitText();
                        if (evt.error) {
                            setError(evt.error.message);
                            chainFailedRef.current = true;
                        }
                        break;
                    }
                }
            }
        } catch (e) {
            const aborted = abortRef.current?.signal.aborted === true;
            if (!aborted) {
                setError(e instanceof Error ? e.message : String(e));
            }
            chainFailedRef.current = true;
        } finally {
            finalizeThinking();
            commitText();
            streamingRef.current = false;
            abortRef.current = null;
            setStreaming(false);
            setStreamingText("");
            if (stateRef.current) {
                setUsedTokens(estimateTokens(stateRef.current.history));
            }
        }

        // Drain the next queued message, if any. User messages are flushed to
        // the chat history at this point — that's the moment they "actually
        // send", and they should appear in scrollback in the right slot
        // relative to the streaming output that follows.
        const next = queueRef.current.shift();
        syncQueueDisplay();
        if (next !== undefined) {
            if (next.kind === "user") {
                appendUserToChat(next.text, next.attachments);
                await sendNow(next.expanded);
            } else {
                await sendNow(next.prompt);
            }
            return;
        }

        // Chain complete — true hand-off back to the user. Post the elapsed
        // time only on the clean path (no aborts, errors, or turn.end errors).
        const startedAt = chainStartRef.current;
        const failed = chainFailedRef.current;
        chainStartRef.current = null;
        chainFailedRef.current = false;
        if (!failed && startedAt !== null) {
            const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
            if (elapsedSec >= 1) {
                setItems((prev) => [
                    ...prev,
                    {
                        kind: "system",
                        id: newChatItemId(),
                        content: `Worked for ${formatElapsed(elapsedSec)}`,
                    },
                ]);
            }
        }
    };

    const send = async (text: string): Promise<void> => {
        if (!stateRef.current || !sessionRef.current || !providerRef.current) {
            setError("session not ready");
            return;
        }
        setError(null);
        recordHistory(text);

        if (parseSlash(text)) {
            await runSlash(text);
            return;
        }

        // First visible user prompt of a fresh session → kick off title gen
        // in the background. Independent of @-expansion: we want the title to
        // reflect the user's intent, not the resolved file dump.
        triggerTitleGeneration(text);

        // Resolve any `@<path>` tokens against the project root and append the
        // file/folder content to the prompt the model sees. The chat UI keeps
        // the original `@path` text — only the LLM-bound prompt is expanded.
        // Each successfully resolved attachment also gets a synthetic `Read`
        // tool-call line so the transcript shows the action that just happened.
        let expanded = text;
        let attachments: readonly ExpandedAttachment[] = [];
        try {
            const result = await expandMentions(text, stateRef.current.projectRoot);
            expanded = result.text;
            attachments = result.attachments;
            // Mentioned files whose full contents were injected count toward
            // the read-before-edit invariant — Edit's freshness check (re-read
            // + hash compare) catches drift the same way it does for Read.
            for (const r of result.reads) {
                stateRef.current.turnState.readFiles.set(r.abs, { hash: r.hash });
            }
        } catch {
            // fall back to raw text on any expansion failure
        }

        if (streamingRef.current) {
            // Hold the message out of `items` until it's actually drained —
            // otherwise streaming output below it would push it up the
            // scrollback. The pinned panel above the input shows it instead.
            queueRef.current.push({
                kind: "user",
                id: newChatItemId(),
                text,
                expanded,
                attachments,
            });
            syncQueueDisplay();
            return;
        }

        appendUserToChat(text, attachments);
        await sendNow(expanded);
    };

    const sendHiddenPrompt = (prompt: string): void => {
        if (!stateRef.current || !sessionRef.current || !providerRef.current) {
            setError("session not ready");
            return;
        }
        if (streamingRef.current) {
            queueRef.current.push({ kind: "hidden", prompt });
            syncQueueDisplay();
            return;
        }
        void sendNow(prompt);
    };

    const activeMention = useMemo(
        () => findActiveMention(currentInput, currentCursor),
        [currentInput, currentCursor],
    );
    const mentionEnabled = activeMention !== null && dismissedMentionQuery !== activeMention.query;

    // Refresh the file index whenever the picker opens, so files created since
    // boot (by the user or the model) appear without a restart. The cached
    // index is shown immediately; ripgrep runs in the background and updates
    // state when it returns. A short TTL coalesces rapid open/close cycles.
    useEffect(() => {
        if (!mentionEnabled) return;
        const root = stateRef.current?.projectRoot;
        if (root === undefined) return;
        let cancelled = false;
        void loadFileIndex(root, { maxAgeMs: 1500 })
            .then((idx) => {
                if (!cancelled) setFileIndex(idx);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [mentionEnabled]);

    const mentionMatches: readonly MentionOption[] = useMemo(() => {
        if (!mentionEnabled || activeMention === null || fileIndex.length === 0) return [];
        return matchFiles(activeMention.query, fileIndex, 8);
    }, [mentionEnabled, activeMention, fileIndex]);
    const mentionOpen = mentionMatches.length > 0;

    // Reset highlight to the top whenever the active mention's query changes,
    // so a fresh `@x` doesn't inherit a stale row from `@xy`.
    const mentionQueryKey = activeMention?.query ?? null;
    useEffect(() => {
        setMentionActive(0);
    }, [mentionQueryKey]);

    // Clear an Esc-dismissal once the user types past the dismissed query (or
    // leaves the mention entirely).
    useEffect(() => {
        if (dismissedMentionQuery !== null && activeMention?.query !== dismissedMentionQuery) {
            setDismissedMentionQuery(null);
        }
    }, [activeMention?.query, dismissedMentionQuery]);

    useEffect(() => {
        let cancelled = false;
        void refreshUpdateStatus()
            .then((s) => {
                if (!cancelled && s) setUpdateStatus(s);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);

    const handleValueChange = (value: string, cursor: number): void => {
        setCurrentInput(value);
        setCurrentCursor(cursor);
    };
    const handleMentionMove = (delta: 1 | -1): void => {
        if (mentionMatches.length === 0) return;
        setMentionActive((i) => (i + delta + mentionMatches.length) % mentionMatches.length);
    };
    const handleMentionAccept = (): string | null => {
        if (mentionMatches.length === 0) return null;
        const safe = Math.min(Math.max(mentionActive, 0), mentionMatches.length - 1);
        return mentionMatches[safe]?.id ?? null;
    };
    const handleMentionDismiss = (): void => {
        if (activeMention) setDismissedMentionQuery(activeMention.query);
    };

    if (bootError !== null) {
        return (
            <Box flexDirection="column" paddingX={1}>
                <Text color="red">Failed to start: {bootError}</Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            <Chat
                key={chatKey}
                items={items}
                streamingText={streamingText}
                streaming={
                    streaming &&
                    !pendingPrompt &&
                    !pendingUserQuestion &&
                    !pendingPicker &&
                    !pendingKeyPrompt
                }
                committedCount={committedCount}
                groupsExpanded={groupsExpanded}
            />
            {error !== null && (
                <Box paddingX={1} marginBottom={1}>
                    <Text color="red">error: {error}</Text>
                </Box>
            )}
            <TodoPanel todos={todos} />
            {queuedDisplay.length > 0 && (
                <Box paddingX={1} flexDirection="column" marginBottom={1}>
                    {queuedDisplay.map((q) => (
                        <Text key={q.id} color="cyan">
                            <Text dimColor>↳ queued </Text>
                            {q.text}
                        </Text>
                    ))}
                </Box>
            )}
            {pendingPrompt ? (
                <PermissionPrompt
                    payload={pendingPrompt.payload}
                    onRespond={pendingPrompt.respond}
                />
            ) : pendingUserQuestion ? (
                <UserQuestion
                    payload={pendingUserQuestion.payload}
                    onRespond={pendingUserQuestion.respond}
                />
            ) : pendingPicker ? (
                <Picker payload={pendingPicker.payload} onRespond={pendingPicker.respond} />
            ) : pendingKeyPrompt ? (
                <KeyPrompt
                    payload={pendingKeyPrompt.payload}
                    onRespond={pendingKeyPrompt.respond}
                />
            ) : (
                <>
                    <SlashPicker input={currentInput} />
                    {mentionOpen && (
                        <MentionPicker matches={mentionMatches} activeIndex={mentionActive} />
                    )}
                    <ChatInput
                        ref={chatInputRef}
                        onSubmit={send}
                        disabled={false}
                        onValueChange={handleValueChange}
                        getCompletion={completeCommand}
                        history={history}
                        mentionOpen={mentionOpen}
                        onMentionMove={handleMentionMove}
                        onMentionAccept={handleMentionAccept}
                        onMentionDismiss={handleMentionDismiss}
                    />
                </>
            )}
            <Box paddingX={1}>
                <Text dimColor>{prettyCwd()}</Text>
            </Box>
            <StatusBar
                mode={mode}
                providerId={providerId}
                model={findModel(model)?.label ?? model}
                streaming={streaming}
                queuedCount={queuedCount}
                usedTokens={usedTokens}
                contextWindow={contextWindow}
                updateStatus={updateStatus}
            />
        </Box>
    );
};
