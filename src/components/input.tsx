import { Box, Text, useInput } from "ink";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { findActiveMention } from "../mentions/index.ts";

interface ChatInputProps {
    readonly onSubmit: (text: string) => void;
    readonly disabled: boolean;
    readonly onValueChange?: (value: string, cursor: number) => void;
    readonly getCompletion?: (value: string) => string | null;
    readonly history?: readonly string[];

    // Mention picker integration. When `mentionOpen` is true, ↑/↓ drive the
    // picker (instead of history), Enter/Tab accept the active option, and Esc
    // dismisses. `onMentionAccept` returns the path to splice in, or null if
    // there is no active option.
    readonly mentionOpen?: boolean;
    readonly onMentionMove?: (delta: 1 | -1) => void;
    readonly onMentionAccept?: () => string | null;
    readonly onMentionDismiss?: () => void;
}

export interface ChatInputHandle {
    clear(): void;
}

// Keys we deliberately handle vs. defer:
//   - Shift+Tab: owned by App (mode cycle) — we ignore.
//   - Tab (no shift): tab-completion via getCompletion when provided, OR
//     accept the active mention when the picker is open.
//   - Ctrl+C: owned by App (clear input → abort stream → no-op).
// Shift+Enter for newline depends on the terminal sending a distinguishable
// sequence (key.shift) — works in iTerm2/kitty with the right config; on
// terminals that fold Shift+Enter into plain Enter, Alt/Option+Enter (key.meta)
// is the fallback.
export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
    {
        onSubmit,
        disabled,
        onValueChange,
        getCompletion,
        history,
        mentionOpen,
        onMentionMove,
        onMentionAccept,
        onMentionDismiss,
    },
    ref,
) {
    const [value, setValue] = useState("");
    const [cursor, setCursor] = useState(0);
    // null = "live" (showing user's draft); otherwise an index into `history`.
    const [historyIndex, setHistoryIndex] = useState<number | null>(null);
    // Saved draft we restore when user navigates back past the most-recent entry.
    const [liveBuffer, setLiveBuffer] = useState("");

    useEffect(() => {
        onValueChange?.(value, cursor);
    }, [value, cursor, onValueChange]);

    useImperativeHandle(
        ref,
        () => ({
            clear: () => {
                setValue("");
                setCursor(0);
                setHistoryIndex(null);
                setLiveBuffer("");
            },
        }),
        [],
    );

    // Any edit (typing, backspace, newline) leaves history-nav mode but keeps
    // the current value — matches readline behavior.
    const exitHistoryNav = (): void => {
        if (historyIndex !== null) {
            setHistoryIndex(null);
            setLiveBuffer("");
        }
    };

    const recallEntry = (index: number): void => {
        const entry = history?.[index] ?? "";
        setValue(entry);
        setCursor(entry.length);
        setHistoryIndex(index);
    };

    const acceptMention = (): boolean => {
        if (!onMentionAccept) return false;
        const replacement = onMentionAccept();
        if (replacement === null) return false;
        const mention = findActiveMention(value, cursor);
        if (!mention) return false;
        const insert = `${replacement} `;
        const next = value.slice(0, mention.start) + insert + value.slice(mention.end);
        setValue(next);
        setCursor(mention.start + insert.length);
        return true;
    };

    useInput((input, key) => {
        if (disabled) return;
        if (key.tab) {
            if (key.shift) return;
            if (mentionOpen && acceptMention()) return;
            if (getCompletion) {
                const completed = getCompletion(value);
                if (completed !== null) {
                    setValue(completed);
                    setCursor(completed.length);
                }
            }
            return;
        }

        if (key.return) {
            if (key.shift || key.meta) {
                exitHistoryNav();
                setValue((v) => v.slice(0, cursor) + "\n" + v.slice(cursor));
                setCursor((c) => c + 1);
                return;
            }
            if (mentionOpen && acceptMention()) return;
            const trimmed = value.trim();
            if (trimmed.length === 0) return;
            onSubmit(value);
            setValue("");
            setCursor(0);
            setHistoryIndex(null);
            setLiveBuffer("");
            return;
        }

        if (key.backspace || key.delete) {
            if (cursor === 0) return;
            exitHistoryNav();
            setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor));
            setCursor((c) => c - 1);
            return;
        }

        if (key.leftArrow) {
            setCursor((c) => Math.max(0, c - 1));
            return;
        }
        if (key.rightArrow) {
            setCursor((c) => Math.min(value.length, c + 1));
            return;
        }

        if (key.upArrow) {
            if (mentionOpen) {
                onMentionMove?.(-1);
                return;
            }
            if (!history || history.length === 0) return;
            // Don't hijack up-arrow inside a multi-line draft unless we're
            // already navigating history.
            if (historyIndex === null && value.includes("\n")) return;
            if (historyIndex === null) {
                setLiveBuffer(value);
                recallEntry(0);
            } else if (historyIndex < history.length - 1) {
                recallEntry(historyIndex + 1);
            }
            return;
        }
        if (key.downArrow) {
            if (mentionOpen) {
                onMentionMove?.(1);
                return;
            }
            if (historyIndex === null) return;
            if (historyIndex === 0) {
                setValue(liveBuffer);
                setCursor(liveBuffer.length);
                setHistoryIndex(null);
                setLiveBuffer("");
            } else {
                recallEntry(historyIndex - 1);
            }
            return;
        }
        if (key.escape) {
            if (mentionOpen) onMentionDismiss?.();
            return;
        }
        if (key.ctrl || key.pageUp || key.pageDown) {
            return;
        }

        if (input.length > 0) {
            exitHistoryNav();
            setValue((v) => v.slice(0, cursor) + input + v.slice(cursor));
            setCursor((c) => c + input.length);
        }
    });

    return (
        <Box borderStyle="round" borderColor={disabled ? "gray" : "cyan"} paddingX={1}>
            <Box marginRight={1}>
                <Text color={disabled ? "gray" : "cyan"}>{">"}</Text>
            </Box>
            <Box flexGrow={1}>{renderWithCursor(value, cursor, disabled)}</Box>
        </Box>
    );
});

const renderWithCursor = (value: string, cursor: number, disabled: boolean) => {
    if (disabled) {
        return <Text dimColor>{value.length > 0 ? value : "…"}</Text>;
    }
    if (value.length === 0) {
        return (
            <Text>
                <Text inverse> </Text>
            </Text>
        );
    }
    if (cursor >= value.length) {
        return (
            <Text>
                {value}
                <Text inverse> </Text>
            </Text>
        );
    }
    const before = value.slice(0, cursor);
    const at = value.slice(cursor, cursor + 1);
    const after = value.slice(cursor + 1);
    if (at === "\n") {
        return (
            <Text>
                {before}
                <Text inverse> </Text>
                {"\n"}
                {after}
            </Text>
        );
    }
    return (
        <Text>
            {before}
            <Text inverse>{at}</Text>
            {after}
        </Text>
    );
};
