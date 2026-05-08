import { Box, Text, useInput } from "ink";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { findActiveMention } from "../mentions/index.ts";

// Convert any line-ending shape to \n. Bracketed-paste content from terminals
// can carry \r\n (CRLF) or lone \r (legacy Mac, some clipboards) — both must
// land in the buffer as plain \n so cursor math and rendering line up.
const normalizePaste = (s: string): string => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

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

    // Synchronous mirrors of `value`/`cursor`. A single paste can split across
    // multiple useInput callbacks within one tick, and React state inside the
    // callback's closure reflects the last *render*, not previous calls in the
    // same tick. Reading/writing through refs keeps all chunks aligned with
    // the latest buffer. State is still the source of truth for rendering and
    // for the onValueChange effect.
    const valueRef = useRef("");
    const cursorRef = useRef(0);
    const apply = (next: string, nextCursor: number): void => {
        valueRef.current = next;
        cursorRef.current = nextCursor;
        setValue(next);
        setCursor(nextCursor);
    };

    useEffect(() => {
        onValueChange?.(value, cursor);
    }, [value, cursor, onValueChange]);

    useImperativeHandle(
        ref,
        () => ({
            clear: () => {
                apply("", 0);
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
        apply(entry, entry.length);
        setHistoryIndex(index);
    };

    const acceptMention = (): boolean => {
        if (!onMentionAccept) return false;
        const replacement = onMentionAccept();
        if (replacement === null) return false;
        const v = valueRef.current;
        const c = cursorRef.current;
        const mention = findActiveMention(v, c);
        if (!mention) return false;
        // Keep the `@` prefix on the inserted token. The token is what gets
        // resolved on submit (see expandMentions), and a leading `@` is the
        // signal that distinguishes a mention from any other path-shaped string.
        const insert = `@${replacement} `;
        apply(
            v.slice(0, mention.start) + insert + v.slice(mention.end),
            mention.start + insert.length,
        );
        return true;
    };

    useInput((input, key) => {
        if (disabled) return;

        // Paste path. Any input chunk longer than a single character is, for
        // our purposes, a paste — humans type one character per event in raw
        // mode. Routing here defeats two failure modes:
        //   (1) a chunk that arrives without `key.return` but contains a \n
        //       would otherwise fall through to the literal-input branch
        //       below, where the closure-captured cursor is stale relative to
        //       earlier chunks of the same paste;
        //   (2) a chunk that *does* set `key.return` or `key.tab` because the
        //       parser keyed on the first byte would otherwise submit or
        //       trigger completion mid-paste.
        // Multi-byte inputs that look like paste but are actually one
        // codepoint (e.g. an emoji surrogate pair) flow through here too —
        // semantics are identical to single-char insertion.
        if (input.length > 1) {
            const text = normalizePaste(input);
            exitHistoryNav();
            const v = valueRef.current;
            const c = cursorRef.current;
            apply(v.slice(0, c) + text + v.slice(c), c + text.length);
            return;
        }

        if (key.tab) {
            if (key.shift) return;
            if (mentionOpen && acceptMention()) return;
            if (getCompletion) {
                const completed = getCompletion(valueRef.current);
                if (completed !== null) apply(completed, completed.length);
            }
            return;
        }

        if (key.return) {
            if (key.shift || key.meta) {
                exitHistoryNav();
                const v = valueRef.current;
                const c = cursorRef.current;
                apply(v.slice(0, c) + "\n" + v.slice(c), c + 1);
                return;
            }
            if (mentionOpen && acceptMention()) return;
            const v = valueRef.current;
            if (v.trim().length === 0) return;
            onSubmit(v);
            apply("", 0);
            setHistoryIndex(null);
            setLiveBuffer("");
            return;
        }

        if (key.backspace || key.delete) {
            const c = cursorRef.current;
            if (c === 0) return;
            exitHistoryNav();
            const v = valueRef.current;
            apply(v.slice(0, c - 1) + v.slice(c), c - 1);
            return;
        }

        if (key.leftArrow) {
            const c = cursorRef.current;
            apply(valueRef.current, Math.max(0, c - 1));
            return;
        }
        if (key.rightArrow) {
            const c = cursorRef.current;
            const v = valueRef.current;
            apply(v, Math.min(v.length, c + 1));
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
            if (historyIndex === null && valueRef.current.includes("\n")) return;
            if (historyIndex === null) {
                setLiveBuffer(valueRef.current);
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
                apply(liveBuffer, liveBuffer.length);
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

        if (input.length === 1) {
            exitHistoryNav();
            const v = valueRef.current;
            const c = cursorRef.current;
            apply(v.slice(0, c) + input + v.slice(c), c + 1);
        }
    });

    return (
        <Box
            borderStyle="single"
            borderColor={disabled ? "gray" : "cyan"}
            borderLeft={false}
            borderRight={false}
            paddingX={1}
            width="100%"
        >
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
