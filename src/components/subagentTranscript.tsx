import { Box, Text, useInput, useStdout } from "ink";
import { useState } from "react";
import type { MailboxMessage } from "../subagents/mailbox.ts";
import { itemKey, RenderItem, type ChatItem } from "./chat.tsx";

interface SubagentTranscriptProps {
    readonly title: string;
    readonly status: string;
    readonly items: readonly ChatItem[];
    readonly queued: readonly MailboxMessage[];
    readonly rejected: readonly MailboxMessage[];
    // Returns "" when the message was queued, otherwise the reason it was not.
    readonly onSend: (text: string) => string;
    readonly onBack: () => void;
    readonly verbose: boolean;
}

// Rows reserved for the header, the scroll markers, the composer, the hint,
// and everything App draws below the transcript (cwd line, status bar, tabs).
const CHROME_ROWS = 14;

const estimateHeight = (item: ChatItem, cols: number): number => {
    if (item.kind === "message" || item.kind === "system") {
        let lines = 0;
        for (const para of item.content.split("\n")) {
            lines += Math.max(1, Math.ceil(para.length / Math.max(1, cols)));
        }
        return lines + 1;
    }
    if (item.kind === "toolCall") return 2 + (item.entry.progress?.length ?? 0);
    return 2;
};

// Fills a line budget backwards from `offset` items above the newest one. Always
// yields at least one item so a single item taller than the viewport still shows.
export const windowFromBottom = (
    heights: readonly number[],
    offset: number,
    maxLines: number,
): { readonly start: number; readonly end: number } => {
    if (heights.length === 0) return { start: 0, end: 0 };
    const end = Math.max(1, heights.length - offset);
    let start = end;
    let used = 0;
    while (start > 0) {
        const height = heights[start - 1]!;
        if (start < end && used + height > maxLines) break;
        used += height;
        start -= 1;
    }
    return { start, end };
};

export const SubagentTranscript = ({
    title,
    status,
    items,
    queued,
    rejected,
    onSend,
    onBack,
    verbose,
}: SubagentTranscriptProps) => {
    const { stdout } = useStdout();
    const cols = stdout?.columns ?? 80;
    const rows = stdout?.rows ?? 24;
    const [offset, setOffset] = useState(0);
    const [draft, setDraft] = useState("");
    const [notice, setNotice] = useState("");

    const maxOffset = Math.max(0, items.length - 1);
    const clampedOffset = Math.min(offset, maxOffset);

    useInput((input, key) => {
        if (key.escape) {
            onBack();
            return;
        }
        if (key.upArrow) {
            setOffset((o) => Math.min(maxOffset, o + 1));
            return;
        }
        if (key.downArrow) {
            setOffset((o) => Math.max(0, o - 1));
            return;
        }
        if (key.return) {
            if (draft.trim().length === 0) return;
            const error = onSend(draft);
            setNotice(error);
            if (error.length === 0) setDraft("");
            return;
        }
        if (key.backspace || key.delete) {
            setDraft((d) => d.slice(0, -1));
            return;
        }
        // Ctrl/Meta chords belong to App (Ctrl+C aborts, Ctrl+O toggles verbose).
        if (key.ctrl || key.meta || key.tab || input.length === 0) return;
        setNotice("");
        setDraft((d) => d + input);
    });

    const heights = items.map((item) => estimateHeight(item, cols));
    const { start, end } = windowFromBottom(
        heights,
        clampedOffset,
        Math.max(4, rows - CHROME_ROWS),
    );
    const visible = items.slice(start, end);

    return (
        <Box flexDirection="column">
            <Box>
                <Text bold>{title}</Text>
                <Text dimColor> · {status}</Text>
                {clampedOffset > 0 && <Text dimColor> · scrolled back {clampedOffset}</Text>}
            </Box>
            {start > 0 && <Text dimColor>↑ {start} earlier</Text>}
            {visible.length === 0 ? (
                <Text dimColor>(no output yet)</Text>
            ) : (
                visible.map((item) => (
                    <RenderItem key={itemKey(item)} item={item} verbose={verbose} />
                ))
            )}
            {end < items.length && <Text dimColor>↓ {items.length - end} newer</Text>}
            {rejected.length > 0 && (
                <Box flexDirection="column">
                    {rejected.map((message) => (
                        <Text key={message.id} color="red">
                            ↳ {message.text} — {message.rejection}
                        </Text>
                    ))}
                </Box>
            )}
            {queued.length > 0 && (
                <Box flexDirection="column">
                    {queued.map((message) => (
                        <Text key={message.id} color="cyan">
                            <Text dimColor>↳ queued </Text>
                            {message.text}
                        </Text>
                    ))}
                    <Text dimColor>delivered at the next turn boundary</Text>
                </Box>
            )}
            {notice.length > 0 && <Text color="red">{notice}</Text>}
            <Box>
                <Text color="cyan">{"› "}</Text>
                {draft.length > 0 ? <Text>{draft}</Text> : <Text dimColor>steer this agent…</Text>}
            </Box>
            <Text dimColor>↑↓ scroll · type to steer · enter send · esc back</Text>
        </Box>
    );
};
