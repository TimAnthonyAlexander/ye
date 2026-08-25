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
    // Rows the agent list below this view occupies, so the window this view
    // fills leaves room for it. The list is one row per agent plus its hint.
    readonly listRows: number;
    // True while the list is asking whether to stop an agent. The confirm key
    // is a bare letter, so the composer has to stand down or it would swallow
    // the answer into the draft.
    readonly composerDisabled: boolean;
    readonly verbose: boolean;
}

// Rows reserved for the header, the truncation marker, the composer, the hint,
// and everything App draws below the transcript (cwd line, status bar).
const CHROME_ROWS = 12;

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
    listRows,
    composerDisabled,
    verbose,
}: SubagentTranscriptProps) => {
    const { stdout } = useStdout();
    const cols = stdout?.columns ?? 80;
    const rows = stdout?.rows ?? 24;
    const [draft, setDraft] = useState("");
    const [notice, setNotice] = useState("");

    useInput((input, key) => {
        if (composerDisabled) return;
        // The arrows belong to the agent list below — they switch agents, the
        // same movement that opened this view. This transcript follows the
        // newest output and is never scrolled, so it has nothing to spend them
        // on. Escape is deliberately unbound: it reads as "stop this agent".
        if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.escape) {
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
        // Ctrl/Meta chords belong to App (Ctrl+C aborts, Ctrl+O toggles
        // verbose) and to the agent list (Ctrl+K stops the selected agent).
        if (key.ctrl || key.meta || key.tab || input.length === 0) return;
        setNotice("");
        setDraft((d) => d + input);
    });

    const heights = items.map((item) => estimateHeight(item, cols));
    // Always the newest output — the view follows the agent instead of being
    // scrolled, so offset is pinned at 0.
    const { start, end } = windowFromBottom(heights, 0, Math.max(4, rows - CHROME_ROWS - listRows));
    const visible = items.slice(start, end);

    return (
        <Box flexDirection="column">
            <Box>
                <Text bold>{title}</Text>
                <Text dimColor> · {status}</Text>
            </Box>
            {start > 0 && <Text dimColor>… {start} earlier off screen</Text>}
            {visible.length === 0 ? (
                <Text dimColor>(no output yet)</Text>
            ) : (
                visible.map((item) => (
                    <RenderItem key={itemKey(item)} item={item} verbose={verbose} />
                ))
            )}
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
            <Text dimColor>type to steer · enter send · ↑↓ switch agent</Text>
        </Box>
    );
};
