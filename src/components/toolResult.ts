import type { ToolResult } from "../tools/index.ts";

export const RESULT_CLIP_CHARS = 200;
export const VERBOSE_MAX_LINES = 100;
export const VERBOSE_MAX_CHARS = 4000;

const resultText = (result: ToolResult): string => {
    if (!result.ok) return result.error;
    return typeof result.value === "string" ? result.value : "";
};

// Collapsed default: errors only, hard-clipped. Unchanged behaviour.
export const collapsedResultText = (result: ToolResult | undefined): string => {
    if (!result || result.ok) return "";
    return result.error.length > RESULT_CLIP_CHARS
        ? `${result.error.slice(0, RESULT_CLIP_CHARS)}…`
        : result.error;
};

const countLines = (text: string): number => {
    let n = 1;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) n++;
    }
    return n;
};

// Verbose form: the whole result, capped so a multi-megabyte Bash dump can't
// flood the scrollback. The char slice happens before the split so the cap
// also bounds the work, not just the output.
export const expandedResultLines = (result: ToolResult | undefined): readonly string[] => {
    if (!result) return [];
    const text = resultText(result).replace(/\s+$/, "");
    if (text.length === 0) return [];
    const head = text.length > VERBOSE_MAX_CHARS ? text.slice(0, VERBOSE_MAX_CHARS) : text;
    const lines = head.split("\n").slice(0, VERBOSE_MAX_LINES);
    const dropped = countLines(text) - lines.length;
    if (dropped > 0) {
        lines.push(`… ${dropped} more line${dropped === 1 ? "" : "s"}`);
    } else if (head.length < text.length) {
        lines.push("… truncated");
    }
    return lines;
};
