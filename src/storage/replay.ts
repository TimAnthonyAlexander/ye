import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionMode } from "../config/index.ts";
import type { Message, ToolCallRequest } from "../providers/index.ts";
import { getProjectSessionsDir } from "./paths.ts";

export interface PromptStartEntry {
    // Ordinal: 0-based position of this prompt within the session.
    readonly ordinal: number;
    // The globalTurnIndex of the first turn that ran for this prompt.
    // Used by /rewind to call rewindToTurn() against the right checkpoint.
    readonly firstTurnGlobalIdx: number;
    readonly preview: string;
    readonly ts: string;
    // Index in the replayed history[] array of this prompt's user message.
    // Used by /rewind to truncate state.history to before this prompt.
    readonly historyIdx: number;
}

export interface ReplayedSession {
    readonly history: readonly Message[];
    readonly mode: PermissionMode | null;
    readonly turnsCompleted: number;
    // Maximum globalTurnIndex observed in the JSONL. Restored into
    // state.globalTurnIndex on resume so subsequent checkpoints don't collide
    // with already-written ones.
    readonly maxGlobalTurnIndex: number;
    readonly prompts: readonly PromptStartEntry[];
    // The set of (toolCallId, name, args, result) triples extracted from the
    // event stream. Used to reconstruct ChatItem rows for the resumed UI so
    // the user sees their prior tool calls instead of just plain text.
    readonly toolCalls: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly args: unknown;
        readonly resultOk: boolean;
        readonly resultText: string;
    }>;
}

interface RawEvent {
    readonly type?: string;
    readonly [key: string]: unknown;
}

const parseLine = (line: string): RawEvent | null => {
    if (line.length === 0) return null;
    try {
        return JSON.parse(line) as RawEvent;
    } catch {
        return null;
    }
};

const renderResultText = (result: unknown): { ok: boolean; text: string } => {
    if (result && typeof result === "object" && "ok" in result) {
        const r = result as { ok: boolean; value?: unknown; error?: string };
        if (r.ok) {
            const value = r.value;
            return {
                ok: true,
                text: typeof value === "string" ? value : JSON.stringify(value),
            };
        }
        return { ok: false, text: `Error: ${r.error ?? "(unknown)"}` };
    }
    return { ok: false, text: "" };
};

// Project the JSONL event stream back into a SessionState-compatible message
// list. Skips shaper.applied / mode.changed / permission.prompt events because
// they don't contribute messages directly. Permissions are explicitly NOT
// restored on resume (re-prompt always — see PERMISSIONS.md).
export const replaySessionFile = async (jsonlPath: string): Promise<ReplayedSession> => {
    const raw = await readFile(jsonlPath, "utf8");
    const lines = raw.split("\n");

    const history: Message[] = [];
    let mode: PermissionMode | null = null;
    let turnsCompleted = 0;
    let maxGlobalTurnIndex = 0;
    const prompts: PromptStartEntry[] = [];
    const toolCalls: Array<{
        id: string;
        name: string;
        args: unknown;
        resultOk: boolean;
        resultText: string;
    }> = [];

    let pendingText = "";
    let pendingToolCalls: ToolCallRequest[] = [];
    let assistantPushed = false;

    const commitAssistant = (): void => {
        if (assistantPushed) return;
        if (pendingText.length === 0 && pendingToolCalls.length === 0) return;
        const msg: Message =
            pendingToolCalls.length > 0
                ? {
                      role: "assistant",
                      content: pendingText.length > 0 ? pendingText : null,
                      tool_calls: pendingToolCalls,
                  }
                : { role: "assistant", content: pendingText };
        history.push(msg);
        assistantPushed = true;
    };

    for (const line of lines) {
        const evt = parseLine(line);
        if (!evt || typeof evt.type !== "string") continue;

        switch (evt.type) {
            case "user.message": {
                commitAssistant();
                if (typeof evt.content === "string") {
                    history.push({ role: "user", content: evt.content });
                }
                pendingText = "";
                pendingToolCalls = [];
                assistantPushed = false;
                break;
            }
            case "turn.start": {
                pendingText = "";
                pendingToolCalls = [];
                assistantPushed = false;
                break;
            }
            case "model.text": {
                if (typeof evt.delta === "string") pendingText += evt.delta;
                break;
            }
            case "model.toolCall": {
                if (
                    typeof evt.id === "string" &&
                    typeof evt.name === "string" &&
                    !pendingToolCalls.some((tc) => tc.id === evt.id)
                ) {
                    pendingToolCalls.push({
                        id: evt.id,
                        type: "function",
                        function: {
                            name: evt.name,
                            arguments: JSON.stringify(evt.args ?? {}),
                        },
                    });
                }
                break;
            }
            case "tool.start": {
                // First tool of the turn: commit the assistant message that
                // owns the tool_calls before any tool result lands.
                commitAssistant();
                break;
            }
            case "tool.end": {
                commitAssistant();
                if (typeof evt.id === "string") {
                    const { ok, text } = renderResultText(evt.result);
                    history.push({
                        role: "tool",
                        tool_call_id: evt.id,
                        content: text,
                    });
                    const matchingCall = pendingToolCalls.find((tc) => tc.id === evt.id);
                    toolCalls.push({
                        id: evt.id,
                        name:
                            typeof evt.name === "string"
                                ? evt.name
                                : (matchingCall?.function.name ?? ""),
                        args: matchingCall ? safeParseArgs(matchingCall.function.arguments) : {},
                        resultOk: ok,
                        resultText: text,
                    });
                }
                break;
            }
            case "turn.end": {
                commitAssistant();
                if (evt.stopReason !== "continue") turnsCompleted += 1;
                break;
            }
            case "mode.changed": {
                if (typeof evt.mode === "string") {
                    mode = evt.mode as PermissionMode;
                }
                break;
            }
            case "prompt.start": {
                if (typeof evt.firstTurnGlobalIdx === "number") {
                    prompts.push({
                        ordinal: prompts.length,
                        firstTurnGlobalIdx: evt.firstTurnGlobalIdx,
                        preview: typeof evt.preview === "string" ? evt.preview : "",
                        ts: typeof evt.ts === "string" ? evt.ts : "",
                        // Last user message currently in history is this prompt.
                        historyIdx: Math.max(0, history.length - 1),
                    });
                    if (evt.firstTurnGlobalIdx > maxGlobalTurnIndex) {
                        // The last turn within this prompt is the largest
                        // globalTurnIndex used; we approximate via the next
                        // prompt's firstTurnGlobalIdx - 1, refined below.
                        maxGlobalTurnIndex = evt.firstTurnGlobalIdx;
                    }
                }
                break;
            }
            case "rewind": {
                // /rewind appends one of these to the JSONL so future replays
                // discard everything after a chosen prompt boundary. Append-
                // only invariant preserved; effect applied at read-time.
                const ordinal = typeof evt.upToPrompt === "number" ? evt.upToPrompt : -1;
                const target = prompts[ordinal];
                if (target) {
                    history.splice(target.historyIdx);
                    prompts.splice(ordinal);
                    pendingText = "";
                    pendingToolCalls = [];
                    assistantPushed = false;
                    // Drop tool-call rows that belong to rewound turns. We
                    // can't know exactly which ones without per-turn indexing,
                    // so we conservatively drop all tool calls whose history
                    // entry no longer exists. Cheap to compute, exact result.
                    const liveIds = new Set<string>();
                    for (const m of history) {
                        if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
                            for (const tc of m.tool_calls) liveIds.add(tc.id);
                        }
                    }
                    for (let i = toolCalls.length - 1; i >= 0; i--) {
                        if (!liveIds.has(toolCalls[i]!.id)) toolCalls.splice(i, 1);
                    }
                }
                break;
            }
        }
    }

    commitAssistant();

    // Refine maxGlobalTurnIndex by looking at consecutive prompt boundaries:
    // the turn before prompt[k+1].firstTurnGlobalIdx is the last turn of
    // prompt[k]. For the latest prompt, default to firstTurnGlobalIdx (a
    // conservative lower bound — actual max might be higher if the prompt
    // ran multiple turns, but on resume we'll just bump from there).
    for (let i = 0; i < prompts.length; i++) {
        const next = prompts[i + 1];
        const cur = prompts[i];
        if (!cur) continue;
        const candidate = next ? next.firstTurnGlobalIdx - 1 : cur.firstTurnGlobalIdx;
        if (candidate > maxGlobalTurnIndex) maxGlobalTurnIndex = candidate;
    }

    return { history, mode, turnsCompleted, maxGlobalTurnIndex, prompts, toolCalls };
};

const safeParseArgs = (raw: string): unknown => {
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
};

export interface SessionSummary {
    readonly sessionId: string;
    readonly path: string;
    readonly modifiedAt: string;
    readonly preview: string;
    readonly userMessageCount: number;
}

const isJsonl = (name: string): boolean => name.endsWith(".jsonl");
const isNotFoundError = (err: unknown): boolean =>
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";

// Lists per-project sessions, newest-modified first. The preview is the first
// user message text, truncated to 80 chars. Empty sessions (only opened, never
// used) are skipped — they're not useful resume targets.
export const listProjectSessions = async (
    projectId: string,
): Promise<readonly SessionSummary[]> => {
    const dir = getProjectSessionsDir(projectId);
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch (err) {
        if (isNotFoundError(err)) return [];
        throw err;
    }

    const summaries: SessionSummary[] = [];
    for (const name of entries) {
        if (!isJsonl(name)) continue;
        const path = join(dir, name);
        let modifiedAt = "";
        try {
            const s = await stat(path);
            if (!s.isFile()) continue;
            modifiedAt = s.mtime.toISOString();
        } catch {
            continue;
        }

        const sessionId = name.replace(/\.jsonl$/, "");
        let preview = "";
        let userMessageCount = 0;

        try {
            const raw = await readFile(path, "utf8");
            for (const line of raw.split("\n")) {
                const evt = parseLine(line);
                if (!evt || evt.type !== "user.message") continue;
                userMessageCount += 1;
                if (preview.length === 0 && typeof evt.content === "string") {
                    const trimmed = evt.content.trim().replace(/\s+/g, " ");
                    preview = trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
                }
            }
        } catch {
            continue;
        }

        if (userMessageCount === 0) continue;
        summaries.push({ sessionId, path, modifiedAt, preview, userMessageCount });
    }

    summaries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return summaries;
};
