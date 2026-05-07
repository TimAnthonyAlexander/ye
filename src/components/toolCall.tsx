import { Box, Text } from "ink";
import type { ToolResult } from "../tools/index.ts";

export type ToolCallStatus = "running" | "done" | "error";

export interface ToolCallEntry {
    readonly id: string;
    readonly name: string;
    readonly args: unknown;
    readonly status: ToolCallStatus;
    readonly result?: ToolResult;
}

const summarizeArgs = (name: string, args: unknown): string => {
    if (typeof args !== "object" || args === null) return "";
    const a = args as Record<string, unknown>;
    switch (name) {
        case "Bash":
            return typeof a["command"] === "string" ? (a["command"] as string) : "";
        case "Read":
        case "Write":
        case "Edit":
            return typeof a["path"] === "string" ? (a["path"] as string) : "";
        case "Glob":
            return typeof a["pattern"] === "string" ? (a["pattern"] as string) : "";
        case "Grep":
            return typeof a["pattern"] === "string" ? (a["pattern"] as string) : "";
        default:
            return "";
    }
};

const summarizeResult = (result: ToolResult | undefined): string => {
    if (!result) return "";
    if (!result.ok) return result.error;
    if (typeof result.value === "string") {
        return result.value.slice(0, 200) + (result.value.length > 200 ? "…" : "");
    }
    const json = JSON.stringify(result.value);
    return json.slice(0, 200) + (json.length > 200 ? "…" : "");
};

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
            </Box>
            {resultSummary.length > 0 && (
                <Box paddingLeft={2}>
                    <Text dimColor>{resultSummary}</Text>
                </Box>
            )}
        </Box>
    );
};
