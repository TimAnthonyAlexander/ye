import { Box, Text, useApp, useInput } from "ink";
import { homedir } from "node:os";
import { useEffect, useRef, useState } from "react";
import {
    completeCommand,
    dispatch,
    parseSlash,
    type SlashCommandContext,
} from "../commands/index.ts";
import type { LoadResult, PermissionMode } from "../config/index.ts";
import type { PermissionPromptPayload, PromptResponse } from "../permissions/index.ts";
import { createSessionState, queryLoop, type SessionState } from "../pipeline/index.ts";
import { getProvider, MissingApiKeyError, type Provider } from "../providers/index.ts";
import { getProjectId, openSession, type SessionHandle } from "../storage/index.ts";
import type { TodoItem } from "../tools/index.ts";
import { cycleMode } from "../ui/keybinds.ts";
import { Chat, type ChatItem } from "./chat.tsx";
import { ChatInput, type ChatInputHandle } from "./input.tsx";
import { PermissionPrompt } from "./permissionPrompt.tsx";
import { SlashPicker } from "./slashPicker.tsx";
import { StatusBar } from "./statusBar.tsx";
import { TodoPanel } from "./todoPanel.tsx";
import type { ToolCallEntry } from "./toolCall.tsx";
import { UserQuestion, type UserQuestionPayload } from "./userQuestion.tsx";

interface AppProps {
    readonly config: LoadResult;
}

interface PendingPrompt {
    readonly payload: PermissionPromptPayload;
    readonly respond: (r: PromptResponse) => void;
}

interface PendingUserQuestion {
    readonly payload: UserQuestionPayload;
    readonly respond: (answer: string) => void;
}

const prettyCwd = (): string => {
    const cwd = process.cwd();
    const home = homedir();
    return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
};

export const App = ({ config }: AppProps) => {
    const cfg = config.config;
    const { exit } = useApp();
    const [mode, setMode] = useState<PermissionMode>(cfg.permissions?.defaultMode ?? "NORMAL");
    const [items, setItems] = useState<ChatItem[]>([]);
    const [streamingText, setStreamingText] = useState("");
    const [streaming, setStreaming] = useState(false);
    const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
    const [pendingUserQuestion, setPendingUserQuestion] =
        useState<PendingUserQuestion | null>(null);
    const [todos, setTodos] = useState<readonly TodoItem[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [bootError, setBootError] = useState<string | null>(null);
    const [currentInput, setCurrentInput] = useState("");

    const stateRef = useRef<SessionState | null>(null);
    const sessionRef = useRef<SessionHandle | null>(null);
    const providerRef = useRef<Provider | null>(null);
    const pendingTodosRef = useRef<readonly TodoItem[] | null>(null);
    const streamingRef = useRef(false);
    const queueRef = useRef<string[]>([]);
    const abortRef = useRef<AbortController | null>(null);
    const chatInputRef = useRef<ChatInputHandle | null>(null);
    const [queuedCount, setQueuedCount] = useState(0);

    const addSystemMessage = (text: string): void => {
        setItems((prev) => [...prev, { kind: "system", content: text }]);
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
        setItems([]);
        setTodos([]);
        setError(null);
    };

    const runSlash = async (text: string): Promise<void> => {
        const parsed = parseSlash(text);
        if (!parsed) return;
        const state = stateRef.current;
        if (!state) {
            setError("session not ready");
            return;
        }
        setItems((prev) => [...prev, { kind: "message", role: "user", content: text }]);
        const ctx: SlashCommandContext = {
            cwd: process.cwd(),
            projectRoot: state.projectRoot,
            projectId: state.projectId,
            mode: state.mode,
            setMode: (next) => {
                state.mode = next;
                state.denialTrail = null;
                setMode(next);
            },
            clearChat: rotateSession,
            exitApp: exit,
            addSystemMessage,
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
                const provider = getProvider(cfg);
                const proj = await getProjectId();
                const { state, session } = await createSessionState({
                    provider,
                    config: cfg,
                    projectId: proj.id,
                    projectRoot: proj.root,
                });
                if (cancelled) {
                    await session.close();
                    return;
                }
                providerRef.current = provider;
                stateRef.current = state;
                sessionRef.current = session;
                setMode(state.mode);
            } catch (e) {
                if (e instanceof MissingApiKeyError) {
                    setBootError(e.message);
                } else {
                    setBootError(e instanceof Error ? e.message : String(e));
                }
            }
        })();
        return () => {
            cancelled = true;
            sessionRef.current?.close().catch(() => {});
        };
    }, [cfg]);

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
                setQueuedCount(0);
                setItems((prev) => [
                    ...prev,
                    { kind: "system", content: "(stopped)" },
                ]);
            }
            return;
        }
        if (key.tab && key.shift && stateRef.current && !pendingPrompt) {
            const next = cycleMode(stateRef.current.mode);
            stateRef.current.mode = next;
            stateRef.current.denialTrail = null;
            setMode(next);
        }
    });

    const sendNow = async (text: string): Promise<void> => {
        streamingRef.current = true;
        abortRef.current = new AbortController();
        setStreaming(true);
        setStreamingText("");

        let currentText = "";

        const commitText = (): void => {
            if (currentText.length === 0) return;
            const committed = currentText;
            currentText = "";
            setStreamingText("");
            setItems((prev) => [
                ...prev,
                { kind: "message", role: "assistant", content: committed },
            ]);
        };

        try {
            const stream = queryLoop({
                provider: providerRef.current!,
                config: cfg,
                state: stateRef.current!,
                session: sessionRef.current!,
                userPrompt: text,
                signal: abortRef.current.signal,
            });

            for await (const evt of stream) {
                switch (evt.type) {
                    case "model.text": {
                        currentText += evt.delta;
                        setStreamingText(currentText);
                        break;
                    }
                    case "model.toolCall": {
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
                        commitText();
                        if (evt.error) setError(evt.error);
                        break;
                    }
                }
            }
        } catch (e) {
            const aborted = abortRef.current?.signal.aborted === true;
            if (!aborted) {
                setError(e instanceof Error ? e.message : String(e));
            }
        } finally {
            commitText();
            streamingRef.current = false;
            abortRef.current = null;
            setStreaming(false);
            setStreamingText("");
        }

        // Drain the next queued message, if any.
        const next = queueRef.current.shift();
        setQueuedCount(queueRef.current.length);
        if (next !== undefined) {
            await sendNow(next);
        }
    };

    const send = async (text: string): Promise<void> => {
        if (!stateRef.current || !sessionRef.current || !providerRef.current) {
            setError("session not ready");
            return;
        }
        setError(null);

        if (parseSlash(text)) {
            await runSlash(text);
            return;
        }

        const userItem: ChatItem = { kind: "message", role: "user", content: text };
        setItems((prev) => [...prev, userItem]);

        if (streamingRef.current) {
            queueRef.current.push(text);
            setQueuedCount(queueRef.current.length);
            return;
        }

        await sendNow(text);
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
                items={items}
                streamingText={streamingText}
                streaming={streaming && !pendingPrompt && !pendingUserQuestion}
            />
            {error !== null && (
                <Box paddingX={1} marginBottom={1}>
                    <Text color="red">error: {error}</Text>
                </Box>
            )}
            <TodoPanel todos={todos} />
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
            ) : (
                <>
                    <SlashPicker input={currentInput} />
                    <ChatInput
                        ref={chatInputRef}
                        onSubmit={send}
                        disabled={false}
                        onValueChange={setCurrentInput}
                        getCompletion={completeCommand}
                    />
                </>
            )}
            <Box paddingX={1}>
                <Text dimColor>{prettyCwd()}</Text>
            </Box>
            <StatusBar
                mode={mode}
                model={cfg.defaultModel.model}
                streaming={streaming}
                queuedCount={queuedCount}
            />
        </Box>
    );
};
