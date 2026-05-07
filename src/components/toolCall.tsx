import { Box, Text } from "ink";
import type { ToolResult } from "../tools/index.ts";
import { prettyPath } from "../ui/path.ts";

export type ToolCallStatus = "running" | "done" | "error";

export interface ToolCallEntry {
    readonly id: string;
    readonly name: string;
    readonly args: unknown;
    readonly status: ToolCallStatus;
    readonly result?: ToolResult;
    readonly progress?: readonly string[];
}

export const summarizeArgs = (name: string, args: unknown): string => {
    if (typeof args !== "object" || args === null) return "";
    const a = args as Record<string, unknown>;
    switch (name) {
        case "Bash":
            return typeof a["command"] === "string" ? (a["command"] as string) : "";
        case "Read":
        case "Write":
        case "Edit":
            return typeof a["path"] === "string" ? prettyPath(a["path"] as string) : "";
        case "Glob":
            return typeof a["pattern"] === "string" ? (a["pattern"] as string) : "";
        case "Grep":
            return typeof a["pattern"] === "string" ? (a["pattern"] as string) : "";
        case "AskUserQuestion":
            return typeof a["question"] === "string" ? (a["question"] as string) : "";
        case "Task": {
            const kind = typeof a["kind"] === "string" ? (a["kind"] as string) : "";
            const prompt = typeof a["prompt"] === "string" ? (a["prompt"] as string) : "";
            return kind && prompt ? `${kind}: ${prompt}` : prompt;
        }
        default:
            return "";
    }
};

const summarizeResult = (result: ToolResult | undefined): string => {
    if (!result || result.ok) return "";
    return result.error.slice(0, 200) + (result.error.length > 200 ? "…" : "");
};

// Action-line answer (shown next to the tool name) for tools where the result
// is a short, human-meaningful string. Returns null if not applicable.
const actionLineAnswer = (
    name: string,
    args: unknown,
    result: ToolResult | undefined,
): string | null => {
    if (!result || !result.ok) return null;
    if (name !== "AskUserQuestion") return null;
    if (typeof result.value !== "string") return null;
    if (result.value.startsWith("User dismissed")) return "(dismissed — user typing reply)";
    const labels = (() => {
        if (typeof args !== "object" || args === null) return [] as string[];
        const raw = (args as { options?: unknown }).options;
        if (!Array.isArray(raw)) return [] as string[];
        return raw
            .map((o) => {
                if (typeof o === "string") return o;
                if (
                    typeof o === "object" &&
                    o !== null &&
                    typeof (o as { label?: unknown }).label === "string"
                ) {
                    return (o as { label: string }).label;
                }
                return null;
            })
            .filter((s): s is string => s !== null);
    })();
    const idx = labels.findIndex((label) => label === result.value);
    const truncated = result.value.length > 60 ? `${result.value.slice(0, 60)}…` : result.value;
    return idx >= 0 ? `[${idx + 1}] ${truncated}` : `(typed) ${truncated}`;
};

const MAX_DIFF_LINES = 20;
const MAX_DIFF_LINE_WIDTH = 120;

interface EditDiff {
    readonly removed: readonly string[];
    readonly added: readonly string[];
    readonly truncated: boolean;
}

const editDiff = (args: unknown): EditDiff | null => {
    if (typeof args !== "object" || args === null) return null;
    const a = args as Record<string, unknown>;
    const oldStr = typeof a["old_string"] === "string" ? (a["old_string"] as string) : null;
    const newStr = typeof a["new_string"] === "string" ? (a["new_string"] as string) : null;
    if (oldStr === null || newStr === null) return null;
    const removed = oldStr.split("\n");
    const added = newStr.split("\n");
    const total = removed.length + added.length;
    if (total <= MAX_DIFF_LINES) {
        return { removed, added, truncated: false };
    }
    const half = Math.floor(MAX_DIFF_LINES / 2);
    return {
        removed: removed.slice(0, Math.min(removed.length, half)),
        added: added.slice(0, Math.min(added.length, MAX_DIFF_LINES - half)),
        truncated: true,
    };
};

const clipLine = (line: string): string =>
    line.length > MAX_DIFF_LINE_WIDTH ? line.slice(0, MAX_DIFF_LINE_WIDTH) + "…" : line;

const statusGlyph = (status: ToolCallStatus): { ch: string; color: string } => {
    switch (status) {
        case "running":
            return { ch: "•", color: "yellow" };
        case "done":
            return { ch: "✓", color: "green" };
        case "error":
            return { ch: "✗", color: "red" };
    }
};

interface Props {
    readonly entry: ToolCallEntry;
}

export const ToolCallView = ({ entry }: Props) => {
    const { ch, color } = statusGlyph(entry.status);
    const argSummary = summarizeArgs(entry.name, entry.args);
    const resultSummary = summarizeResult(entry.result);
    const answerLine = actionLineAnswer(entry.name, entry.args, entry.result);
    const diff =
        entry.name === "Edit" && (entry.status === "done" || entry.status === "running")
            ? editDiff(entry.args)
            : null;
    const showDiff = diff !== null && entry.result?.ok !== false;
    const showProgress =
        entry.name === "Task" &&
        entry.status === "running" &&
        entry.progress !== undefined &&
        entry.progress.length > 0;
    return (
        <Box flexDirection="column" marginBottom={1}>
            <Box>
                <Text color={color}>{ch} </Text>
                <Text bold>{entry.name}</Text>
                {argSummary.length > 0 && (
                    <Text dimColor>
                        {" "}
                        · {argSummary.slice(0, 80)}
                        {argSummary.length > 80 ? "…" : ""}
                    </Text>
                )}
                {answerLine !== null && (
                    <Text>
                        {" "}
                        → <Text color="cyan">{answerLine}</Text>
                    </Text>
                )}
            </Box>
            {showProgress && entry.progress && (
                <Box flexDirection="column" paddingLeft={2}>
                    {entry.progress.map((line, i) => (
                        <Text key={`p-${i}`} dimColor>
                            ↳ {clipLine(line)}
                        </Text>
                    ))}
                </Box>
            )}
            {showDiff && (
                <Box flexDirection="column" paddingLeft={2}>
                    {diff.removed.map((line, i) => (
                        <Text key={`-${i}`} color="red">
                            - {clipLine(line)}
                        </Text>
                    ))}
                    {diff.added.map((line, i) => (
                        <Text key={`+${i}`} color="green">
                            + {clipLine(line)}
                        </Text>
                    ))}
                    {diff.truncated && <Text dimColor>… diff truncated</Text>}
                </Box>
            )}
            {resultSummary.length > 0 && (
                <Box paddingLeft={2}>
                    <Text dimColor>{resultSummary}</Text>
                </Box>
            )}
        </Box>
    );
};
