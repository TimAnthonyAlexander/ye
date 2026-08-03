import { Box, Text, useApp, useInput, useStdout } from "ink";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import pkg from "../../package.json" with { type: "json" };
import {
    completeCommand,
    dispatch,
    loadMarkdownCommands,
    parseSlash,
    setExtraCommands,
    setMarkdownCommands,
    type OutputSink,
    type PickerPayload,
    type SlashCommandContext,
} from "../commands/index.ts";
import { runAside } from "../commands/aside.ts";
import { runInstall } from "../commands/lsp.ts";
import { type InstallOffer, pendingOffers, recordDecline } from "../lsp/install/index.ts";
import { runManualCompact } from "../pipeline/shapers/manualCompact.ts";
import {
    buildSkillToolDescription,
    loadSkillRegistry,
    skillToSlashCommand,
    type SkillRegistry,
} from "../skills/index.ts";
import { buildContextSnapshot } from "../context/snapshot.ts";
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
import {
    type Config,
    type LoadResult,
    type PermissionMode,
    persistPermissionRule,
    saveConfig,
    withPermissionRule,
} from "../config/index.ts";
import {
    deriveAlwaysRule,
    type PermissionPromptPayload,
    type PromptResponse,
    restoredSessionRules,
    sessionRulesPersisted,
} from "../permissions/index.ts";
import { createSessionState, queryLoop, type SessionState } from "../pipeline/index.ts";
import { resetShapingFlags } from "../pipeline/state.ts";
import {
    anyBackgroundRunning,
    waitForAnyBackgroundCompletion,
    WAKEUP_REMINDERS,
} from "../pipeline/backgroundWakeup.ts";
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
import { findFreeModelLabel } from "../providers/openrouter/freeModels.ts";
import { stripAllReasoningDetails } from "../providers/openrouter/reasoningPolicy.ts";
import { clearPinnedUpstreams } from "../pipeline/routing.ts";
import {
    appendHistory,
    generateSessionTitle,
    getProjectId,
    listProjectSessions,
    loadHistory,
    loadUsageTotals,
    openExistingSession,
    openSession,
    recordSessionRule,
    recordSessionTitle,
    replaySessionFile,
    resetTerminalTitle,
    resolveTitleCall,
    rewindToTurn,
    type SessionHandle,
    type SessionSummary,
    writeTerminalTitle,
} from "../storage/index.ts";
import {
    generateSuggestion,
    lastRoleText,
    NO_SUGGESTION,
    reduceSuggestion,
    shouldGenerateSuggestion,
    type SuggestionEvent,
    type SuggestionState,
} from "../suggest/index.ts";
import type { TodoItem } from "../tools/index.ts";
import { cycleMode } from "../ui/keybinds.ts";
import { refreshUpdateStatus, type UpdateStatus } from "../update/check.ts";
import { Chat, type ChatItem, computeDynamicStart, newChatItemId } from "./chat.tsx";
import { ChatInput, type ChatInputHandle } from "./input.tsx";
import { runBangCommand } from "./bangCommand.ts";
import { runEventHooks } from "../hooks/index.ts";
import { destroyBackgroundManager, getBackgroundManager } from "../tools/bash/background.ts";
import {
    destroyBackgroundSubagentManager,
    getBackgroundSubagentManager,
    type BackgroundSubagentTask,
    type SubagentItem,
} from "../subagents/background.ts";
import { Home, HOME_MIN_COLS, HOME_MIN_ROWS } from "./home.tsx";
import { LspOffer } from "./lspOffer.tsx";
import { pickTip } from "./homeTips.ts";
import { KeyPrompt } from "./keyPrompt.tsx";
import { MentionPicker } from "./mentionPicker.tsx";
import { PermissionPrompt } from "./permissionPrompt.tsx";
import { Picker } from "./picker.tsx";
import { SubagentTabBar } from "./subagentTabBar.tsx";
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
    readonly modeOnStart?: string | null;
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

const getUsername = (): string | null => {
    try {
        const u = userInfo().username;
        return u.length > 0 ? u : null;
    } catch {
        return null;
    }
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

const toChatItem = (item: SubagentItem): ChatItem => {
    if (item.kind === "text") {
        return { kind: "message", id: item.id, role: "assistant", content: item.content };
    }
    const entry: ToolCallEntry = {
        id: item.id,
        name: item.name,
        args: item.args,
        status: item.status,
        ...(item.progress ? { progress: item.progress } : {}),
    };
    return { kind: "toolCall", entry };
};

export const App = ({ config, resumeOnStart, resumeSessionId, modeOnStart }: AppProps) => {
    const initialCfg = config.config;
    const { exit } = useApp();
    const [mode, setMode] = useState<PermissionMode>(
        (modeOnStart as PermissionMode | undefined) ??
            initialCfg.permissions?.defaultMode ??
            "NORMAL",
    );
    const [providerId, setProviderId] = useState<string>(initialCfg.defaultProvider);
    const [model, setModelState] = useState<string>(initialCfg.defaultModel.model);
    const [items, setItems] = useState<ChatItem[]>([]);
    const [homeRecents, setHomeRecents] = useState<readonly SessionSummary[]>([]);
    const [homeRecentsLoaded, setHomeRecentsLoaded] = useState(false);
    const [homeTip, setHomeTip] = useState<string>(() => pickTip(projectHasNotes(process.cwd())));
    const homeUsername = useMemo<string | null>(() => getUsername(), []);
    const [streamingText, setStreamingText] = useState("");
    const [streaming, setStreaming] = useState(false);
    const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
    const [pendingUserQuestion, setPendingUserQuestion] = useState<PendingUserQuestion | null>(
        null,
    );
    const [pendingPicker, setPendingPicker] = useState<PendingPicker | null>(null);
    const [pendingKeyPrompt, setPendingKeyPrompt] = useState<PendingKeyPrompt | null>(null);
    // At most one language-server install offer, surfaced once per session
    // start. Never a queue: the second one waits for the next session.
    const [lspOffer, setLspOffer] = useState<InstallOffer | null>(null);
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
    const [committedCount, setCommittedCount] = useState(0);
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
    const [suggestion, setSuggestion] = useState<SuggestionState>(NO_SUGGESTION);
    const suggestionRef = useRef<SuggestionState>(NO_SUGGESTION);
    const dispatchSuggestion = (event: SuggestionEvent): void => {
        const next = reduceSuggestion(suggestionRef.current, event);
        if (next === suggestionRef.current) return;
        suggestionRef.current = next;
        setSuggestion(next);
    };

    const stateRef = useRef<SessionState | null>(null);
    const sessionRef = useRef<SessionHandle | null>(null);
    const providerRef = useRef<Provider | null>(null);
    // Loaded asynchronously after session boot. Held in a ref so /context can
    // include skill manifests in its snapshot without forcing a re-render when
    // the registry arrives.
    const skillRegistryRef = useRef<SkillRegistry | null>(null);
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
    const bgWakeupRef = useRef<AbortController | null>(null);
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
    const [bgTaskCount, setBgTaskCount] = useState(0);
    // null = normal chat view, "main" = tabs visible, task id = inside subagent
    const [subagentView, setSubagentView] = useState<string | null>(null);
    const [subagentTasks, setSubagentTasks] = useState<readonly BackgroundSubagentTask[]>([]);
    // When true, arrow keys go to the tab bar instead of history.
    const [tabBarFocused, setTabBarFocused] = useState(false);
    const [tokenUsage, setTokenUsage] = useState<{
        readonly input: number;
        readonly output: number;
        readonly cached: number;
        readonly costUsd: number;
    }>({ input: 0, output: 0, cached: 0, costUsd: 0 });
    const [sessionTokenUsage, setSessionTokenUsage] = useState<{
        readonly input: number;
        readonly output: number;
        readonly cached: number;
        readonly costUsd: number;
    }>({ input: 0, output: 0, cached: 0, costUsd: 0 });
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

    useEffect(() => {
        let cancelled = false;
        loadUsageTotals()
            .then((totals) => {
                if (cancelled) return;
                setTokenUsage({
                    input: totals.inputTokens,
                    output: totals.outputTokens,
                    cached: totals.cacheReadTokens,
                    costUsd: totals.costUsd,
                });
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, []);

    // Terminal resize handling. <Static>-committed items live in scrollback
    // at whatever width was current when they were emitted. After a resize,
    // the terminal soft-wraps those rows at the new width, but Ink's internal
    // row count for the live region still reflects the OLD layout — which
    // leaves the input box (and any other live siblings) drawing on top of
    // the wrong rows, producing the "broken" cascade. The fix mirrors what
    // rotateSession does for a session reset: clear screen+scrollback, reset
    // the commit boundary, and remount <Chat> via chatKey so every item
    // re-emits to scrollback at the new width. Debounced so a slow drag of
    // the terminal corner doesn't fire dozens of clears.
    const { stdout } = useStdout();
    const [termCols, setTermCols] = useState(stdout?.columns ?? 80);
    const [termRows, setTermRows] = useState(stdout?.rows ?? 24);
    useEffect(() => {
        if (!stdout) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onResize = (): void => {
            setTermCols(stdout.columns ?? 80);
            setTermRows(stdout.rows ?? 24);
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
                setCommittedCount(0);
                bumpChatKey();
            }, 50);
        };
        stdout.on("resize", onResize);
        return () => {
            if (timer) clearTimeout(timer);
            stdout.off("resize", onResize);
        };
    }, [stdout]);

    const refreshBgCount = (): void => {
        const s = stateRef.current;
        if (s) {
            const bashCount = getBackgroundManager(s.sessionId).runningCount();
            const subagentCount = getBackgroundSubagentManager(s.sessionId).runningCount();
            setBgTaskCount(bashCount + subagentCount);
        }
    };

    // Poll the background subagent manager when tabs are visible so items and
    // statuses update live.
    useEffect(() => {
        if (subagentView === null) return;
        const id = setInterval(() => {
            const s = stateRef.current;
            if (!s) return;
            const mgr = getBackgroundSubagentManager(s.sessionId);
            const tasks: BackgroundSubagentTask[] = [];
            for (const t of mgr.allTasks()) {
                if (t.status === "running" || !t.delivered) tasks.push(t);
            }
            // Auto-hide tabs when no tasks remain.
            if (tasks.length === 0) {
                setSubagentView(null);
                setTabBarFocused(false);
            } else {
                setSubagentTasks(tasks);
                // If viewing a subagent that just finished, return to main.
                const viewed = tasks.find((t) => t.id === subagentView);
                if (viewed && viewed.status !== "running") {
                    setSubagentView("main");
                    setTabBarFocused(true);
                }
            }
        }, 500);
        return () => clearInterval(id);
    }, [subagentView]);

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

    // Progress lines are batched into whole chat items rather than mutated in
    // place: outside a stream every item is committed to Ink's <Static> as soon
    // as it settles, and a committed item never re-renders.
    const streamOutput = (): OutputSink => {
        let buffer: string[] = [];
        let timer: ReturnType<typeof setTimeout> | null = null;
        const flush = (): void => {
            timer = null;
            if (buffer.length === 0) return;
            const text = buffer.join("\n");
            buffer = [];
            addSystemMessage(text);
        };
        return {
            write: (line: string) => {
                buffer.push(line);
                if (timer === null) timer = setTimeout(flush, 400);
            },
            close: () => {
                if (timer !== null) clearTimeout(timer);
                flush();
            },
        };
    };

    // "allow_always" never reaches the pipeline: it is a UI-level shorthand for
    // "allow this call, and write a narrow rule to the config". The current call
    // goes through as allow_once so the session never gains a grant wider than
    // the rule the user just read on screen.
    const applyPromptDecision = (
        payload: PermissionPromptPayload,
        decision: PromptResponse,
    ): PromptResponse => {
        if (decision === "allow_always") {
            const derived = deriveAlwaysRule(payload.toolCall);
            if (derived.kind === "none") {
                addSystemMessage(
                    `Allowed for this session only — no narrow always-rule could be derived (${derived.reason}).`,
                );
                return "allow_session";
            }
            stateRef.current?.sessionRules.push(derived.rule);
            cfgRef.current = withPermissionRule(cfgRef.current, derived.rule);
            void persistPermissionRule(derived.rule)
                .then(() => addSystemMessage(`Always allowing ${derived.text}.`))
                .catch((e: unknown) =>
                    addSystemMessage(
                        `Could not save ${derived.text}: ${e instanceof Error ? e.message : String(e)}`,
                    ),
                );
            return "allow_once";
        }
        if (decision === "allow_session" && sessionRulesPersisted(cfgRef.current)) {
            const session = sessionRef.current;
            if (session) {
                void recordSessionRule(session, {
                    effect: "allow",
                    tool: payload.toolCall.name,
                }).catch(() => {});
            }
        }
        return decision;
    };

    const refreshHome = (projectId: string): void => {
        setHomeTip(pickTip(projectHasNotes(process.cwd())));
        listProjectSessions(projectId)
            .then((sessions) => {
                setHomeRecents(sessions);
                setHomeRecentsLoaded(true);
            })
            .catch(() => setHomeRecentsLoaded(true));
    };

    const syncQueueDisplay = (): void => {
        setQueuedCount(queueRef.current.length);
        setQueuedDisplay(
            queueRef.current
                .filter((q): q is Extract<QueuedSend, { kind: "user" }> => q.kind === "user")
                .map((q) => ({ id: q.id, text: q.text })),
        );
    };

    // ↑ on an empty input pulls the newest queued message back out for editing.
    // Only the raw typed text is restored — mentions are re-expanded (and their
    // attachments rebuilt) when it's submitted again.
    const popQueuedForEdit = (): string | null => {
        for (let i = queueRef.current.length - 1; i >= 0; i--) {
            const entry = queueRef.current[i]!;
            if (entry.kind !== "user") continue;
            queueRef.current.splice(i, 1);
            syncQueueDisplay();
            return entry.text;
        }
        return null;
    };

    const appendUserToChat = (text: string, attachments: readonly ExpandedAttachment[]): void => {
        const userItem: ChatItem = {
            kind: "message",
            id: newChatItemId(),
            role: "user",
            content: text,
        };
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
        // First message of a fresh session: prepend a small Ye banner so the
        // wordmark sits at the top of scrollback. It scrolls away naturally
        // once enough rows accumulate — relative, not pinned.
        setItems((prev) => {
            const lead: ChatItem[] =
                prev.length === 0
                    ? [{ kind: "banner", id: newChatItemId(), version: pkg.version }]
                    : [];
            return [...prev, ...lead, userItem, ...readItems];
        });
    };

    const rotateSession = async (): Promise<void> => {
        const state = stateRef.current;
        if (!state) return;
        const oldSession = sessionRef.current;
        const newSession = await openSession(state.projectId);
        sessionRef.current = newSession;
        if (oldSession) {
            destroyBackgroundManager(oldSession.sessionId);
            destroyBackgroundSubagentManager(oldSession.sessionId);
            await oldSession.close().catch(() => {});
        }
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
        setSessionTokenUsage({ input: 0, output: 0, cached: 0, costUsd: 0 });
        setBgTaskCount(0);
        titleGeneratedRef.current = false;
        resetTerminalTitle();
        bumpChatKey();
        // Items already promoted to <Static> live in terminal scrollback,
        // outside React's tree — clearing items state alone won't reclaim
        // those rows. ESC[2J clears the visible screen, ESC[3J the scrollback.
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
        refreshHome(state.projectId);
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
        const state = stateRef.current;
        if (!provider || !session || !state) return;
        const target = resolveTitleCall(cfgRef.current, provider);
        if (!target) return;
        titleGeneratedRef.current = true;
        void (async () => {
            try {
                const title = await generateSessionTitle({
                    provider: target.provider,
                    model: target.model,
                    userPrompt,
                    sessionId: state.sessionId,
                    projectId: state.projectId,
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

    // Fire-and-forget prediction of the user's next prompt, shown as ghost text
    // in the empty input. Routed through resolveInternalCall so it runs on
    // config.cheapModel when one is set. Every failure is silent — a suggestion
    // that doesn't arrive is simply a suggestion the user never sees.
    const triggerSuggestion = (chainFailed: boolean): void => {
        const state = stateRef.current;
        const provider = providerRef.current;
        if (!state || !provider) return;
        const lastUserPrompt = lastRoleText(state.history, "user");
        const gate = shouldGenerateSuggestion({
            enabled: cfgRef.current.suggestions?.enabled === true,
            chainFailed,
            streaming: streamingRef.current,
            showing: suggestionRef.current.text !== null,
            lastUserPrompt,
        });
        if (!gate) return;
        void generateSuggestion({
            config: cfgRef.current,
            activeProvider: provider,
            activeModel: state.activeModel ?? cfgRef.current.defaultModel.model,
            lastUserPrompt,
            lastAssistantText: lastRoleText(state.history, "assistant"),
            sessionId: state.sessionId,
            projectId: state.projectId,
        })
            .then((text) => {
                if (text === null || streamingRef.current) return;
                dispatchSuggestion({ type: "show", text });
            })
            .catch(() => {});
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
        state.sessionRules = restoredSessionRules(cfgRef.current, replayed.sessionRules);
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
        setSessionTokenUsage({ input: 0, output: 0, cached: 0, costUsd: 0 });
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
        // Grants made under a rewound prompt are gone from the re-replay, so the
        // in-memory set is rebuilt from it rather than kept.
        state.sessionRules = restoredSessionRules(cfgRef.current, after.sessionRules);
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
        // Provider switches always cross model-version boundaries; strip
        // reasoning_details unconditionally (same rationale as switchModel).
        const stripped = stripAllReasoningDetails(state.history);
        if (stripped !== state.history) {
            state.history.length = 0;
            state.history.push(...stripped);
        }
        clearPinnedUpstreams(state);
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
        const priorModel = state.activeModel ?? cfgRef.current.defaultModel.model;
        if (priorModel !== nextModel) {
            // Signatures and encrypted reasoning blobs are model-version-bound;
            // sending them into a different model produces cryptic 400s
            // (Anthropic "Invalid signature in thinking block", etc).
            const stripped = stripAllReasoningDetails(state.history);
            if (stripped !== state.history) {
                state.history.length = 0;
                state.history.push(...stripped);
            }
            clearPinnedUpstreams(state);
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

    // The banner is an offer, not a gate — this only runs when the user asks
    // for the chooser, and only an explicit "install" installs anything. Esc,
    // "not now" and simply typing all leave the machine untouched.
    const openLspOffer = async (offer: InstallOffer): Promise<void> => {
        const choice = await pick({
            title: `Install a language server for ${offer.displayName}?`,
            options: [
                { id: "install", label: "Install now", description: offer.command },
                { id: "later", label: "Not now", description: "may be offered again next session" },
                {
                    id: "never",
                    label: `Never for ${offer.language}`,
                    description: "remembered across sessions; /lsp install undoes it",
                },
            ],
            initialId: "later",
        });
        setLspOffer(null);
        if (choice === "never") {
            recordDecline(offer.language);
            addSystemMessage(
                `Ye will not offer a ${offer.language} language server again. \`/lsp install ${offer.language}\` still works.`,
            );
            return;
        }
        if (choice !== "install") return;
        const result = await runInstall(offer.language, { addSystemMessage, streamOutput });
        if (result.kind === "error") setError(result.message);
    };

    const askAside = async (question: string): Promise<void> => {
        const state = stateRef.current;
        const provider = providerRef.current;
        if (!state || !provider) throw new Error("session not ready");

        const ctrl = new AbortController();
        abortRef.current = ctrl;
        streamingRef.current = true;
        setStreaming(true);
        setStreamingText("");

        let text = "";
        let flush: ReturnType<typeof setTimeout> | null = null;
        const scheduleFlush = (): void => {
            if (flush !== null) return;
            flush = setTimeout(() => {
                flush = null;
                setStreamingText(text);
            }, 16);
        };

        try {
            const answer = await runAside({
                state,
                provider,
                config: cfgRef.current,
                model: state.activeModel ?? cfgRef.current.defaultModel.model,
                question,
                signal: ctrl.signal,
                onDelta: (delta) => {
                    text += delta;
                    scheduleFlush();
                },
            });
            if (answer.length > 0) {
                setItems((prev) => [
                    ...prev,
                    { kind: "message", id: newChatItemId(), role: "assistant", content: answer },
                    {
                        kind: "system",
                        id: newChatItemId(),
                        content: "(off the record — not added to conversation history)",
                    },
                ]);
            }
        } catch (e) {
            if (!ctrl.signal.aborted) throw e;
        } finally {
            if (flush !== null) clearTimeout(flush);
            streamingRef.current = false;
            abortRef.current = null;
            setStreaming(false);
            setStreamingText("");
        }

        // Queued sends only drain at the end of a stream, and an aside holds the
        // same streaming flag — without this they would sit there forever.
        const next = queueRef.current.shift();
        syncQueueDisplay();
        if (next === undefined) return;
        if (next.kind === "user") {
            appendUserToChat(next.text, next.attachments);
            await sendNow(next.expanded);
            return;
        }
        await sendNow(next.prompt);
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
            sessionId: state.sessionId,
            mode: state.mode,
            providerId,
            model,
            config: cfgRef.current,
            contextWindow: state.contextWindow,
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
            streamOutput,
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
            showContextPanel: async () => {
                const state = stateRef.current;
                if (!state) return false;
                let username: string | undefined;
                try {
                    const u = userInfo().username;
                    if (u.length > 0) username = u;
                } catch {
                    // ignore
                }
                const snapshot = await buildContextSnapshot({
                    state,
                    providerId,
                    model,
                    config: cfgRef.current,
                    skillRegistry: skillRegistryRef.current ?? {
                        all: new Map(),
                        modelInvocable: [],
                        slashBound: [],
                    },
                    ...(username ? { username } : {}),
                });
                setItems((prev) => [...prev, { kind: "context", id: newChatItemId(), snapshot }]);
                return true;
            },
            pick,
            getHistory: () => stateRef.current?.history ?? [],
            getSessionRules: () => stateRef.current?.sessionRules ?? [],
            getBackgroundTaskCount: () => {
                const s = stateRef.current;
                if (!s) return 0;
                return (
                    getBackgroundManager(s.sessionId).runningCount() +
                    getBackgroundSubagentManager(s.sessionId).runningCount()
                );
            },
            compact: async (focus: string) => {
                const s = stateRef.current;
                const p = providerRef.current;
                if (!s || !p) throw new Error("session not ready");
                const result = await runManualCompact({
                    state: s,
                    provider: p,
                    config: cfgRef.current,
                    model: s.activeModel ?? cfgRef.current.defaultModel.model,
                    focus,
                });
                setUsedTokens(estimateTokens(s.history));
                return result;
            },
            askAside,
        };
        const result = await dispatch(parsed, ctx);
        if (result.kind === "error") {
            setError(result.message);
        }
    };

    // `!<command>` runs the command in the local shell, shows the output in the
    // chat, and feeds it to the model as a turn so it can react. Detected in
    // `send` before @-expansion, mirroring the slash short-circuit.
    const runBang = async (raw: string): Promise<void> => {
        const state = stateRef.current;
        if (!state) {
            setError("session not ready");
            return;
        }
        const command = raw.trimStart().slice(1).trim();
        if (command.length === 0) return;
        setItems((prev) => [
            ...prev,
            { kind: "message", id: newChatItemId(), role: "user", content: `! ${command}` },
        ]);
        const output = await runBangCommand(
            command,
            state.projectRoot,
            new AbortController().signal,
        );
        addSystemMessage(output);
        sendHiddenPrompt(
            `I ran a shell command in the terminal via the \`!\` prefix:\n\n$ ${command}\n\n${output}`,
        );
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
                    modeOverride: modeOnStart ?? undefined,
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
                refreshHome(proj.id);

                // One offer, once, at session start — this effect runs on mount
                // only, so /resume, /clear and a rewind can never re-trigger it.
                // Headless exits in cli.tsx before App is rendered, and a
                // non-TTY run is not interactive, so neither can reach it.
                const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
                const offer = pendingOffers(built.cfg, state.projectRoot, { interactive })[0];
                if (offer !== undefined) setLspOffer(offer);

                // SessionStart hook: fire-and-forget after provider + session are ready.
                void runEventHooks(
                    built.cfg.hooks,
                    "SessionStart",
                    { project_dir: state.projectRoot },
                    new AbortController().signal,
                );

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
                        skillRegistryRef.current = registry;
                        setSkillRegistry(registry, buildSkillToolDescription(registry));
                        setExtraCommands(registry.slashBound.map(skillToSlashCommand));
                    })
                    .catch(() => {});
                loadMarkdownCommands({ projectRoot: state.projectRoot })
                    .then((cmds) => {
                        if (!cancelled) setMarkdownCommands(cmds);
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
            const s = sessionRef.current;
            if (s) {
                destroyBackgroundManager(s.sessionId);
                destroyBackgroundSubagentManager(s.sessionId);
            }
            s?.close().catch(() => {});
        };
        // The config prop never changes for the lifetime of App (cli.tsx mounts
        // once); cfgRef is mutated in place. eslint-disable-next-line is
        // intentional — depending on `config` triggers a remount with the
        // initial config and would lose persisted keys.
    }, [config]);

    useInput((input, key) => {
        if (key.ctrl && input === "c") {
            // Ctrl+C: cancel reverse-search → clear input → abort stream → no-op.
            // Use /exit to quit. Search is checked first because it empties the
            // buffer while active, so currentInput is "" and Ctrl+C would
            // otherwise fall through and abort a live stream.
            if (chatInputRef.current?.isSearching()) {
                chatInputRef.current.cancelSearch();
                return;
            }
            if (currentInput.length > 0) {
                chatInputRef.current?.clear();
                return;
            }
            if (streamingRef.current && abortRef.current) {
                // If the user already queued a follow-up while the model was
                // streaming, treat Ctrl+C as "interrupt and proceed": abort
                // the current turn and let sendNow's finally-path drain the
                // next queued message immediately. Otherwise, clear and post
                // a "(stopped)" marker so the user sees the abort took effect.
                const hasQueued = queueRef.current.length > 0;
                abortRef.current.abort();
                if (hasQueued) {
                    return;
                }
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
            setGroupsExpanded((v) => !v);
            return;
        }
        if (key.downArrow && subagentView === null && bgTaskCount > 0) {
            setSubagentView("main");
            setTabBarFocused(true);
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
        dispatchSuggestion({ type: "send" });
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

        // Promote streaming text to a scrollback message item. Only fires at
        // the genuine end of a text block — model.toolCall or turn.end —
        // never on a mid-stream timer. computeDynamicStart treats assistant
        // messages as committed-eligible the instant they appear in items,
        // and Ink's <Static> is append-only, so any commit that happens
        // before the text block is fully done freezes a half-written row in
        // scrollback and silently swallows everything that arrives after.
        const commitText = (): void => {
            cancelPendingFlush();
            if (currentText.length === 0) return;
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
                    case "model.usage": {
                        const dCost = evt.usage.costUsd ?? 0;
                        setTokenUsage((prev) => ({
                            input: prev.input + evt.usage.inputTokens,
                            output: prev.output + evt.usage.outputTokens,
                            cached: prev.cached + (evt.usage.cacheReadTokens ?? 0),
                            costUsd: prev.costUsd + dCost,
                        }));
                        setSessionTokenUsage((prev) => ({
                            input: prev.input + evt.usage.inputTokens,
                            output: prev.output + evt.usage.outputTokens,
                            cached: prev.cached + (evt.usage.cacheReadTokens ?? 0),
                            costUsd: prev.costUsd + dCost,
                        }));
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
                                    evt.respond(applyPromptDecision(evt.payload, decision));
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
                        if (evt.error || evt.stopReason === "user_cancel") {
                            if (evt.error) setError(evt.error.message);
                            chainFailedRef.current = true;
                        }
                        if (evt.message) {
                            setItems((prev) => [
                                ...prev,
                                {
                                    kind: "system",
                                    id: newChatItemId(),
                                    content: evt.message ?? "",
                                },
                            ]);
                        }
                        void loadUsageTotals()
                            .then((totals) => {
                                setTokenUsage({
                                    input: totals.inputTokens,
                                    output: totals.outputTokens,
                                    cached: totals.cacheReadTokens,
                                    costUsd: totals.costUsd,
                                });
                            })
                            .catch(() => {});
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
            refreshBgCount();
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

        // Stop hook: fire-and-forget after the agent finishes responding.
        if (!failed) {
            void runEventHooks(
                cfgRef.current.hooks,
                "Stop",
                { project_dir: stateRef.current!.projectRoot },
                new AbortController().signal,
            );
        }

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

        triggerSuggestion(failed);

        // Proactive background wakeup: if any bash task or subagent is still
        // running, wait for whichever finishes FIRST and auto-trigger a new turn
        // so the model sees the notification without the user having to send a
        // message. One raced wait, not one per kind — waiting on bash first would
        // hold a finished subagent's summary hostage to an unrelated build.
        const sessionId = stateRef.current!.sessionId;
        if (anyBackgroundRunning(sessionId)) {
            const ctrl = new AbortController();
            bgWakeupRef.current = ctrl;
            try {
                const kind = await waitForAnyBackgroundCompletion(sessionId, ctrl.signal);
                refreshBgCount();
                if (!ctrl.signal.aborted) {
                    await sendNow(WAKEUP_REMINDERS[kind]);
                }
            } catch {
                // Aborted — user sent a message, normal flow takes over.
            } finally {
                if (bgWakeupRef.current === ctrl) bgWakeupRef.current = null;
            }
        }
    };

    const send = async (text: string): Promise<void> => {
        if (!stateRef.current || !sessionRef.current || !providerRef.current) {
            setError("session not ready");
            return;
        }
        setError(null);
        dispatchSuggestion({ type: "send" });
        recordHistory(text);

        // Abort any pending background-task wakeup — user input takes priority.
        bgWakeupRef.current?.abort();
        bgWakeupRef.current = null;

        if (parseSlash(text)) {
            await runSlash(text);
            return;
        }

        if (text.trimStart().startsWith("!")) {
            await runBang(text);
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
            for (const r of result.reads) {
                stateRef.current.turnState.readFiles.set(r.abs, { hash: r.hash });
            }
        } catch {}

        // UserPromptSubmit hook: may inject context into the model-bound prompt.
        const promptHook = await runEventHooks(
            cfgRef.current.hooks,
            "UserPromptSubmit",
            { prompt: text, project_dir: stateRef.current.projectRoot },
            new AbortController().signal,
        );
        if (promptHook.blocked) {
            setError(promptHook.reason ?? "UserPromptSubmit hook blocked");
            return;
        }
        if (promptHook.context && promptHook.context.length > 0) {
            expanded = `${promptHook.context}\n\n${expanded}`;
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

    const showHome =
        items.length === 0 &&
        !pendingPrompt &&
        !pendingUserQuestion &&
        !pendingPicker &&
        !pendingKeyPrompt &&
        termCols >= HOME_MIN_COLS &&
        termRows >= HOME_MIN_ROWS;

    // The offer lives on the start screen only: once the user has sent
    // anything, it stops being an offer and starts being clutter.
    const showLspOffer =
        lspOffer !== null &&
        items.length === 0 &&
        !pendingPrompt &&
        !pendingUserQuestion &&
        !pendingPicker &&
        !pendingKeyPrompt;

    return (
        <Box flexDirection="column">
            {showHome && (
                <Home
                    version={pkg.version}
                    username={homeUsername}
                    cwd={prettyCwd()}
                    providerId={providerId}
                    model={findModel(model)?.label ?? findFreeModelLabel(model) ?? model}
                    recents={homeRecents}
                    recentsLoaded={homeRecentsLoaded}
                    tip={homeTip}
                    inputEmpty={currentInput.length === 0}
                    onResume={(id) => {
                        void loadSession(id).catch((e) => {
                            setError(
                                `resume failed: ${e instanceof Error ? e.message : String(e)}`,
                            );
                        });
                    }}
                />
            )}
            <Chat
                key={chatKey}
                items={
                    subagentView !== null && subagentView !== "main"
                        ? (subagentTasks
                              .find((t) => t.id === subagentView)
                              ?.items.map(toChatItem) ?? [])
                        : items
                }
                streamingText={
                    subagentView !== null && subagentView !== "main" ? "" : streamingText
                }
                streaming={
                    (subagentView === null || subagentView === "main") &&
                    streaming &&
                    !pendingPrompt &&
                    !pendingUserQuestion &&
                    !pendingPicker &&
                    !pendingKeyPrompt
                }
                committedCount={
                    subagentView !== null && subagentView !== "main" ? 0 : committedCount
                }
                groupsExpanded={groupsExpanded}
            />
            {(subagentView === null || subagentView === "main") && (
                <>
                    {error !== null && (
                        <Box marginBottom={1}>
                            <Text color="red">error: {error}</Text>
                        </Box>
                    )}
                    <TodoPanel todos={todos} />
                    {queuedDisplay.length > 0 && (
                        <Box flexDirection="column" marginBottom={1}>
                            {queuedDisplay.map((q) => (
                                <Text key={q.id} color="cyan">
                                    <Text dimColor>↳ queued </Text>
                                    {q.text}
                                </Text>
                            ))}
                            <Text dimColor>↑ to edit</Text>
                        </Box>
                    )}
                    {showLspOffer && lspOffer !== null && (
                        <LspOffer
                            offer={lspOffer}
                            onOpen={() => {
                                void openLspOffer(lspOffer);
                            }}
                        />
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
                                <MentionPicker
                                    matches={mentionMatches}
                                    activeIndex={mentionActive}
                                />
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
                                historyDisabled={showHome || tabBarFocused}
                                onUnqueue={popQueuedForEdit}
                                suggestion={suggestion.text}
                                onSuggestionAccept={() => dispatchSuggestion({ type: "accept" })}
                                onSuggestionDismiss={() => dispatchSuggestion({ type: "dismiss" })}
                            />
                        </>
                    )}
                </>
            )}
            <Box>
                <Text dimColor>{prettyCwd()}</Text>
            </Box>
            <StatusBar
                mode={mode}
                providerId={providerId}
                model={findModel(model)?.label ?? findFreeModelLabel(model) ?? model}
                streaming={streaming}
                queuedCount={queuedCount}
                usedTokens={usedTokens}
                contextWindow={contextWindow}
                updateStatus={updateStatus}
                tokenUsage={tokenUsage}
                sessionTokenUsage={sessionTokenUsage}
                bgTaskCount={bgTaskCount}
            />
            {subagentView !== null && (
                <SubagentTabBar
                    tasks={subagentTasks}
                    selectedTab={subagentView}
                    onSelectTab={(tab) => {
                        setSubagentView(tab);
                        setTabBarFocused(true);
                    }}
                    onEnter={(tab) => {
                        setSubagentView(tab);
                        // Keep focus when entering a subagent so arrow keys still work.
                        if (tab !== "main") setTabBarFocused(true);
                    }}
                    focused={tabBarFocused}
                    onFocusBack={() => {
                        setTabBarFocused(false);
                        setSubagentView("main");
                    }}
                    alwaysFocused={subagentView !== null && subagentView !== "main"}
                />
            )}
        </Box>
    );
};
