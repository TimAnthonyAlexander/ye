import { Box, Text, useInput, useStdin, useStdout, type Key } from "ink";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { findActiveMention } from "../mentions/index.ts";
import { findActiveEmoji } from "../emoji/index.ts";
import { visibleSuggestion } from "../suggest/index.ts";
import { KITTY_KEYBOARD_ENABLE, editInEditor } from "../ui/editor.ts";
import { cycleMatch, highlightMatch, previewEntry, searchHistory } from "../ui/historySearch.ts";

// Convert any line-ending shape to \n. Bracketed-paste content from terminals
// can carry \r\n (CRLF) or lone \r (legacy Mac, some clipboards) — both must
// land in the buffer as plain \n so cursor math and rendering line up.
export const normalizePaste = (s: string): string => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const toQueryText = (s: string): string => normalizePaste(s).replace(/\n/g, " ");

// Word navigation helpers for Ctrl+Arrow and Ctrl/Meta+Backspace.
// Word separators: newline, space, tab.
const isWordSep = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n";

// Step back one full Unicode code point — not one UTF-16 code unit. A surrogate
// pair (😂 = U+1F602, two code units) must be treated as a single character,
// otherwise backspace splits it into a lone surrogate (the � replacement char).
export const prevCodePoint = (s: string, cursor: number): number => {
    if (cursor <= 0) return 0;
    const cu = s.charCodeAt(cursor - 1);
    if (cu >= 0xdc00 && cu <= 0xdfff && cursor >= 2) return cursor - 2;
    return cursor - 1;
};

export const prevWordStart = (value: string, cursor: number): number => {
    if (cursor <= 0) return 0;
    let i = cursor - 1;
    while (i > 0 && isWordSep(value[i]!)) i--;
    while (i > 0 && !isWordSep(value[i - 1]!)) i--;
    return i;
};

export const nextWordStart = (value: string, cursor: number): number => {
    if (cursor >= value.length) return value.length;
    let i = cursor;
    while (i < value.length && !isWordSep(value[i]!)) i++;
    while (i < value.length && isWordSep(value[i]!)) i++;
    return i;
};

// Logical-line bounds for the readline motions (Ctrl+A/E/K/U). A "line" is
// delimited by \n — never the whole buffer, and never a wrapped visual row.
export const lineStart = (value: string, cursor: number): number => {
    if (cursor <= 0) return 0;
    const nl = value.lastIndexOf("\n", cursor - 1);
    return nl === -1 ? 0 : nl + 1;
};

export const lineEnd = (value: string, cursor: number): number => {
    const nl = value.indexOf("\n", Math.max(0, cursor));
    return nl === -1 ? value.length : nl;
};

interface LineKill {
    readonly value: string;
    readonly cursor: number;
    readonly killed: string;
}

export const killToLineEnd = (value: string, cursor: number): LineKill => {
    const end = lineEnd(value, cursor);
    return {
        value: value.slice(0, cursor) + value.slice(end),
        cursor,
        killed: value.slice(cursor, end),
    };
};

export const killToLineStart = (value: string, cursor: number): LineKill => {
    const start = lineStart(value, cursor);
    return {
        value: value.slice(0, start) + value.slice(cursor),
        cursor: start,
        killed: value.slice(start, cursor),
    };
};

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

    // Slash-command picker integration, same shape as the mention picker.
    // `onSlashAccept` returns the selected command's name, or null when there
    // is no selection. Tab completes the selection into the buffer; Enter
    // submits it outright.
    readonly slashOpen?: boolean;
    readonly onSlashMove?: (delta: 1 | -1) => void;
    readonly onSlashAccept?: () => string | null;
    readonly onSlashDismiss?: () => void;

    // When true, ↑/↓ are no-ops here so another component (the Home screen)
    // can claim them. Mention picker takes precedence — its arrow handling
    // remains active even when historyDisabled is set.
    readonly historyDisabled?: boolean;

    // Emoji picker integration. Same shape as mention/slash pickers. When
    // `emojiOpen` is true, ↑/↓ drive the picker, Enter/Tab insert the active
    // option, and Esc dismisses. `onEmojiAccept` returns the emoji character.
    readonly emojiOpen?: boolean;
    readonly onEmojiMove?: (delta: 1 | -1) => void;
    readonly onEmojiAccept?: () => string | null;
    readonly onEmojiDismiss?: () => void;

    // ↑ on an empty buffer pulls the most recently queued message back out of
    // the queue and into the input for editing. Returns its text, or null when
    // there is nothing queued — in which case ↑ falls through to history.
    readonly onUnqueue?: () => string | null;

    // Predicted next prompt, rendered as dim ghost text in an otherwise empty,
    // idle input. Tab / → accept it into the buffer without submitting; Esc or
    // any text-producing key dismisses it.
    readonly suggestion?: string | null;
    readonly onSuggestionAccept?: () => void;
    readonly onSuggestionDismiss?: () => void;
}

export interface ChatInputHandle {
    clear(): void;
    isSearching(): boolean;
    cancelSearch(): void;
}

interface SearchState {
    readonly query: string;
    readonly index: number;
    // Buffer to restore when the search is cancelled.
    readonly saved: string;
    readonly savedCursor: number;
}

// Keys we deliberately handle vs. defer:
//   - Shift+Tab: owned by App (mode cycle) — we ignore.
//   - Tab (no shift): tab-completion via getCompletion when provided, OR
//     accept the active mention when the picker is open.
//   - Ctrl+C: owned by App (clear input → abort stream → no-op).
//   - Ctrl+G: compose the buffer in $VISUAL/$EDITOR.
//   - Ctrl+R: reverse search over cross-session prompt history.
//   - Tab / →: accept the ghost suggestion, but only after the mention picker
//     and command completion have had their turn.
//   - Ctrl+A/E/K/U/Y and Home/End: readline motions over the logical line.
//     Home/End reach us as Ctrl+A/Ctrl+E — patch-stdin rewrites them, because
//     Ink's Key exposes no flag for either.
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
        slashOpen,
        onSlashMove,
        onSlashAccept,
        onSlashDismiss,
        historyDisabled,
        onUnqueue,
        suggestion,
        onSuggestionAccept,
        onSuggestionDismiss,
        emojiOpen,
        onEmojiMove,
        onEmojiAccept,
        onEmojiDismiss,
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

    // Reverse search. While active the buffer is emptied and the original is
    // parked in `saved` — App keys its own Ctrl+C off the reported input value,
    // so leaving the draft in place would let App clear it out from under us.
    const [search, setSearch] = useState<SearchState | null>(null);
    const searchRef = useRef<SearchState | null>(null);
    const applySearch = (next: SearchState | null): void => {
        searchRef.current = next;
        setSearch(next);
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
                applySearch(null);
            },
            isSearching: () => searchRef.current !== null,
            cancelSearch: () => {
                const active = searchRef.current;
                if (active) cancelSearch(active);
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

    const slashCompletion = (): string | null => {
        if (!onSlashAccept) return null;
        const name = onSlashAccept();
        if (name === null) return null;
        return `/${name} `;
    };

    const acceptSlash = (): boolean => {
        const completed = slashCompletion();
        if (completed === null) return false;
        apply(completed, completed.length);
        return true;
    };

    const acceptEmoji = (): boolean => {
        if (!onEmojiAccept) return false;
        const replacement = onEmojiAccept();
        if (replacement === null) return false;
        // Replace the `:query` span with the emoji character. Re-parse from the
        // live refs since the buffer may have been modified earlier this tick.
        const activeEmoji = findActiveEmoji(valueRef.current, cursorRef.current);
        if (!activeEmoji) return false;
        apply(
            valueRef.current.slice(0, activeEmoji.start) +
                replacement +
                valueRef.current.slice(activeEmoji.end),
            activeEmoji.start + replacement.length,
        );
        return true;
    };

    // Single-slot kill ring shared by Ctrl+K, Ctrl+U and Ctrl+Y.
    const killRef = useRef("");
    const killLine = (next: string, nextCursor: number, killed: string): void => {
        exitHistoryNav();
        // An empty kill leaves the ring alone — otherwise Ctrl+K on an already
        // empty line would silently discard what Ctrl+Y is about to yank.
        if (killed.length > 0) killRef.current = killed;
        apply(next, nextCursor);
    };

    const { stdin, setRawMode, isRawModeSupported } = useStdin();

    // Hand the terminal to the editor and take it back afterwards. The spawn is
    // synchronous on purpose: it blocks Ink's event loop, so Ink can neither
    // steal the keystrokes meant for the editor nor paint a frame over it.
    const openEditor = (): void => {
        const tty = stdin.isTTY === true;
        if (isRawModeSupported) setRawMode(false);
        if (tty) stdin.setRawMode(false);
        try {
            const edited = editInEditor(valueRef.current);
            if (edited === null) return;
            exitHistoryNav();
            apply(edited, edited.length);
        } finally {
            if (tty) stdin.setRawMode(true);
            if (isRawModeSupported) setRawMode(true);
            if (process.stdout.isTTY) process.stdout.write(KITTY_KEYBOARD_ENABLE);
        }
    };

    const cancelSearch = (active: SearchState): void => {
        applySearch(null);
        apply(active.saved, active.savedCursor);
    };

    // Ctrl+C is deliberately absent here: App owns it and calls cancelSearch()
    // through the ref. Handling it in both places would cancel the search AND
    // abort a live stream from the one keypress.
    const handleSearchKey = (input: string, key: Key, active: SearchState): void => {
        if (key.escape) {
            cancelSearch(active);
            return;
        }
        // Paste, for the same reason the main handler checks length first: a
        // chunk can carry key.return and would otherwise accept the match.
        if (input.length > 1) {
            applySearch({ ...active, query: active.query + toQueryText(input), index: 0 });
            return;
        }
        const matches = searchHistory(history ?? [], active.query);
        if (key.ctrl && input === "r") {
            applySearch({ ...active, index: cycleMatch(matches.length, active.index) });
            return;
        }
        if (key.return) {
            const picked = matches[active.index];
            applySearch(null);
            if (picked === undefined) apply(active.saved, active.savedCursor);
            else apply(picked, picked.length);
            return;
        }
        if (key.backspace || key.delete) {
            applySearch({ ...active, query: active.query.slice(0, -1), index: 0 });
            return;
        }
        if (key.ctrl || key.meta || key.tab || key.pageUp || key.pageDown) return;
        if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
        if (input.length === 0) return;
        applySearch({ ...active, query: active.query + toQueryText(input), index: 0 });
    };

    const takeSuggestion = (text: string): void => {
        exitHistoryNav();
        apply(text, text.length);
        onSuggestionAccept?.();
    };

    useInput((input, key) => {
        if (disabled) return;

        const searching = searchRef.current;
        if (searching) {
            handleSearchKey(input, key, searching);
            return;
        }

        // `searching`/`disabled` are already ruled out by the early returns above.
        const ghost = visibleSuggestion({
            suggestion: suggestion ?? null,
            buffer: valueRef.current,
            mentionOpen: mentionOpen === true,
            searching: false,
            disabled: false,
        });

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
            if (ghost !== null) onSuggestionDismiss?.();
            exitHistoryNav();
            const v = valueRef.current;
            const c = cursorRef.current;
            apply(v.slice(0, c) + text + v.slice(c), c + text.length);
            return;
        }

        if (key.tab) {
            if (key.shift) return;
            if (mentionOpen && acceptMention()) return;
            if (slashOpen && acceptSlash()) return;
            if (emojiOpen && acceptEmoji()) return;
            if (getCompletion) {
                const completed = getCompletion(valueRef.current);
                if (completed !== null) {
                    apply(completed, completed.length);
                    return;
                }
            }
            if (ghost !== null) takeSuggestion(ghost);
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
            if (emojiOpen && acceptEmoji()) return;
            // Enter on a highlighted command runs it — completing and waiting
            // for a second Enter is a keystroke nobody wants. Tab still just
            // completes, which is the way to reach a command's arguments.
            const picked = slashOpen ? slashCompletion() : null;
            const v = picked !== null ? picked.trimEnd() : valueRef.current;
            if (v.trim().length === 0) return;
            onSubmit(v);
            apply("", 0);
            setHistoryIndex(null);
            setLiveBuffer("");
            return;
        }

        if (key.ctrl && input === "g") {
            if (mentionOpen) return;
            openEditor();
            return;
        }

        if (key.ctrl && input === "r") {
            if (mentionOpen) return;
            exitHistoryNav();
            applySearch({
                query: "",
                index: 0,
                saved: valueRef.current,
                savedCursor: cursorRef.current,
            });
            apply("", 0);
            return;
        }

        if (key.ctrl && input === "a") {
            const v = valueRef.current;
            apply(v, lineStart(v, cursorRef.current));
            return;
        }
        if (key.ctrl && input === "e") {
            const v = valueRef.current;
            apply(v, lineEnd(v, cursorRef.current));
            return;
        }
        if (key.ctrl && input === "k") {
            const kill = killToLineEnd(valueRef.current, cursorRef.current);
            killLine(kill.value, kill.cursor, kill.killed);
            return;
        }
        if (key.ctrl && input === "u") {
            const kill = killToLineStart(valueRef.current, cursorRef.current);
            killLine(kill.value, kill.cursor, kill.killed);
            return;
        }
        if (key.ctrl && input === "y") {
            const yanked = killRef.current;
            if (yanked.length === 0) return;
            exitHistoryNav();
            const v = valueRef.current;
            const c = cursorRef.current;
            apply(v.slice(0, c) + yanked + v.slice(c), c + yanked.length);
            return;
        }

        // Ctrl+W: delete word backwards (readline standard). Also covers
        // Ctrl+Backspace — with the Kitty keyboard protocol enabled, Ctrl+Backspace
        // produces a distinct sequence (ESC [ 127 ; 5 u) which our patched
        // parseKeypress decodes as { name: 'backspace', ctrl: true }, handled below.
        if (key.ctrl && input === "w") {
            exitHistoryNav();
            const v = valueRef.current;
            const c = cursorRef.current;
            const start = prevWordStart(v, c);
            apply(v.slice(0, start) + v.slice(c), start);
            return;
        }

        // Ctrl/Meta + Backspace/Delete: delete word.
        // With Kitty protocol: Ctrl+Backspace = { name:'backspace', ctrl:true },
        // Option+Backspace = { name:'backspace', meta:true }.
        // Without Kitty (legacy terminals): Option+Backspace sends ESC DEL which
        // the original parser decodes as { name:'delete', meta:true }.
        if ((key.ctrl || key.meta) && key.backspace) {
            exitHistoryNav();
            const v = valueRef.current;
            const c = cursorRef.current;
            const start = prevWordStart(v, c);
            apply(v.slice(0, start) + v.slice(c), start);
            return;
        }
        if ((key.ctrl || key.meta) && key.delete) {
            exitHistoryNav();
            const v = valueRef.current;
            const c = cursorRef.current;
            const end = nextWordStart(v, c);
            apply(v.slice(0, c) + v.slice(end), c);
            return;
        }

        // Word navigation.
        // With Kitty protocol: Ctrl/Alt+Arrow set leftArrow/rightArrow + ctrl/meta.
        // Without Kitty (macOS Terminal.app etc.): Option+Arrow sends ESC b / ESC f
        // which the original parser decodes as { meta:true } with input='b'/'f'.
        if ((key.ctrl || key.meta) && (key.leftArrow || input === "b")) {
            const v = valueRef.current;
            const c = cursorRef.current;
            apply(v, prevWordStart(v, c));
            return;
        }
        if ((key.ctrl || key.meta) && (key.rightArrow || input === "f")) {
            const v = valueRef.current;
            const c = cursorRef.current;
            apply(v, nextWordStart(v, c));
            return;
        }

        if (key.backspace || key.delete) {
            const c = cursorRef.current;
            if (c === 0) return;
            exitHistoryNav();
            const v = valueRef.current;
            const prev = prevCodePoint(v, c);
            apply(v.slice(0, prev) + v.slice(c), prev);
            return;
        }

        if (key.leftArrow) {
            const c = cursorRef.current;
            apply(valueRef.current, Math.max(0, c - 1));
            return;
        }
        if (key.rightArrow) {
            if (ghost !== null) {
                takeSuggestion(ghost);
                return;
            }
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
            if (slashOpen) {
                onSlashMove?.(-1);
                return;
            }
            if (emojiOpen) {
                onEmojiMove?.(-1);
                return;
            }
            if (historyDisabled) return;
            // Editing a queued message wins over history recall, but only on an
            // empty buffer so ↑ can never clobber a draft the user is typing.
            if (onUnqueue && valueRef.current.length === 0) {
                const queued = onUnqueue();
                if (queued !== null) {
                    exitHistoryNav();
                    apply(queued, queued.length);
                    return;
                }
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
            if (slashOpen) {
                onSlashMove?.(1);
                return;
            }
            if (emojiOpen) {
                onEmojiMove?.(1);
                return;
            }
            if (historyDisabled) return;
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
            if (slashOpen) onSlashDismiss?.();
            if (emojiOpen) onEmojiDismiss?.();
            if (ghost !== null) onSuggestionDismiss?.();
            return;
        }
        if (key.ctrl || key.pageUp || key.pageDown) {
            return;
        }

        if (input.length === 1) {
            if (ghost !== null) onSuggestionDismiss?.();
            exitHistoryNav();
            const v = valueRef.current;
            const c = cursorRef.current;
            apply(v.slice(0, c) + input + v.slice(c), c + 1);
        }
    });

    const { stdout } = useStdout();
    // Track columns in state so a terminal resize triggers a re-render.
    // useStdout returns the stream but doesn't subscribe to its `resize` event,
    // so without this the cached `inner` width stays stale and visual-row
    // chunking misaligns until the next keystroke forces a re-render.
    const [columns, setColumns] = useState(stdout?.columns ?? 80);
    useEffect(() => {
        if (!stdout) return;
        const onResize = (): void => setColumns(stdout.columns ?? 80);
        stdout.on("resize", onResize);
        return () => {
            stdout.off("resize", onResize);
        };
    }, [stdout]);
    if (search) {
        const matches = searchHistory(history ?? [], search.query);
        return (
            <Box
                borderStyle="single"
                borderColor="magenta"
                borderLeft={false}
                borderRight={false}
                width="100%"
            >
                <Box>
                    <Text color="magenta">{"> "}</Text>
                </Box>
                <Box flexGrow={1} flexDirection="column">
                    {renderSearch(
                        search.query,
                        matches[search.index],
                        search.index,
                        matches.length,
                    )}
                </Box>
            </Box>
        );
    }

    // Inner content width = terminal cols − prefix "> " (2 cols) − 1 col held
    // back for the block cursor, which renders one char PAST the row text when
    // it sits at end-of-row. Without that slack a full row emits cols+1 chars,
    // the terminal soft-wraps it, and Ink's erase (which counts unwrapped rows)
    // comes up short — leaving a stale copy of the top border on every redraw.
    // Floor at 8 to keep the math sane on absurdly narrow terminals.
    const inner = Math.max(8, columns - 3);
    // `!<command>` runs in the shell — accent the whole input (border, marker,
    // text) the moment the buffer starts with "!" so command mode is obvious.
    const bang = !disabled && value.trimStart().startsWith("!");
    const accent = disabled ? "gray" : bang ? "yellow" : "cyan";
    const ghostText = visibleSuggestion({
        suggestion: suggestion ?? null,
        buffer: value,
        mentionOpen: mentionOpen === true,
        searching: false,
        disabled,
    });

    return (
        <Box
            borderStyle="single"
            borderColor={accent}
            borderLeft={false}
            borderRight={false}
            width="100%"
        >
            <Box>
                <Text color={accent}>{"> "}</Text>
            </Box>
            <Box flexGrow={1} flexDirection="column">
                {ghostText !== null
                    ? renderGhost(ghostText)
                    : renderWithCursor(value, cursor, disabled, inner, bang ? "yellow" : undefined)}
            </Box>
        </Box>
    );
});

// Cursor block first, ghost text dimmed after it: the buffer really is empty,
// and dim-after-cursor is what separates a prediction from typed input.
const renderGhost = (text: string) => (
    <Text wrap="truncate">
        <Text inverse> </Text>
        <Text dimColor>{`${text}  ·  tab`}</Text>
    </Text>
);

const renderSearch = (query: string, match: string | undefined, index: number, total: number) => {
    const label = match === undefined ? "(failed reverse-i-search)" : "(reverse-i-search)";
    const parts = match === undefined ? null : highlightMatch(previewEntry(match), query);
    return (
        <>
            <Text wrap="truncate">
                <Text dimColor>{`${label}\`${query}': `}</Text>
                {parts && (
                    <Text>
                        {parts.before}
                        <Text color="magenta" bold>
                            {parts.hit}
                        </Text>
                        {parts.after}
                    </Text>
                )}
            </Text>
            <Text dimColor>
                {total > 1 ? `${index + 1}/${total} · ` : ""}
                Ctrl+R next · Enter accept · Esc cancel
            </Text>
        </>
    );
};

// Cap on visible *visual* rows inside the input. Ink 5 falls back to
// clearTerminal-based redraws when the live region exceeds the terminal
// viewport, which manifests as the input box duplicating across the screen
// on every keystroke (and leaving ghost frames in scrollback that Ink can
// no longer reach). We chunk content into visual rows by terminal width so
// a single very long pasted line is just as bounded as a multi-line paste.
const MAX_VISIBLE_ROWS = 10;

interface VisualRow {
    readonly text: string;
    // Byte offset in the full `value` where this row starts. Used to map the
    // cursor index onto the row that owns it.
    readonly startInValue: number;
}

// Chunk `value` into visual rows of at most `width` cols each. Splits first
// on \n (preserving empty rows for blank lines), then on `width` for any
// logical line longer than the viewport. The cursor's logical position is
// preserved by tracking each row's byte offset back into `value`.
export const buildVisualRows = (value: string, width: number): readonly VisualRow[] => {
    const rows: VisualRow[] = [];
    const w = Math.max(1, width);
    const lines = value.split("\n");
    let offset = 0;
    for (const line of lines) {
        if (line.length === 0) {
            rows.push({ text: "", startInValue: offset });
        } else {
            for (let i = 0; i < line.length; i += w) {
                rows.push({ text: line.slice(i, i + w), startInValue: offset + i });
            }
        }
        offset += line.length + 1;
    }
    if (rows.length === 0) rows.push({ text: "", startInValue: 0 });
    return rows;
};

export const findCursorRow = (rows: readonly VisualRow[], cursor: number): number => {
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]!.startInValue <= cursor) return i;
    }
    return 0;
};

const renderWithCursor = (
    value: string,
    cursor: number,
    disabled: boolean,
    width: number,
    color?: string,
) => {
    if (disabled) {
        return <Text dimColor>{value.length > 0 ? value : "…"}</Text>;
    }

    const rows = buildVisualRows(value, width);
    const focusRow = findCursorRow(rows, cursor);

    let start = 0;
    let end = rows.length;
    if (rows.length > MAX_VISIBLE_ROWS) {
        const half = Math.floor(MAX_VISIBLE_ROWS / 2);
        start = Math.max(0, focusRow - half);
        end = Math.min(rows.length, start + MAX_VISIBLE_ROWS);
        start = Math.max(0, end - MAX_VISIBLE_ROWS);
    }
    const above = start;
    const below = rows.length - end;
    const visible = rows.slice(start, end);

    return (
        <>
            {above > 0 && (
                <Text dimColor>
                    ↑ {above} more row{above === 1 ? "" : "s"}
                </Text>
            )}
            {visible.map((row, idx) => {
                const absoluteIdx = start + idx;
                const cursorOffset = absoluteIdx === focusRow ? cursor - row.startInValue : null;
                return renderRow(row, cursorOffset, absoluteIdx, color);
            })}
            {below > 0 && (
                <Text dimColor>
                    ↓ {below} more row{below === 1 ? "" : "s"}
                </Text>
            )}
        </>
    );
};

const renderRow = (row: VisualRow, cursorOffset: number | null, key: number, color?: string) => {
    if (cursorOffset === null) {
        // Render an empty row as a single space so it claims one row of
        // vertical space — an empty <Text> can collapse and skew the layout.
        return (
            <Text key={key} wrap="truncate" color={color}>
                {row.text.length > 0 ? row.text : " "}
            </Text>
        );
    }
    if (cursorOffset >= row.text.length) {
        return (
            <Text key={key} wrap="truncate" color={color}>
                {row.text}
                <Text inverse> </Text>
            </Text>
        );
    }
    const before = row.text.slice(0, cursorOffset);
    const at = row.text.slice(cursorOffset, cursorOffset + 1);
    const after = row.text.slice(cursorOffset + 1);
    return (
        <Text key={key} wrap="truncate" color={color}>
            {before}
            <Text inverse>{at}</Text>
            {after}
        </Text>
    );
};
