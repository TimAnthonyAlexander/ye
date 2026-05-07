import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

interface ChatInputProps {
    readonly onSubmit: (text: string) => void;
    readonly disabled: boolean;
    readonly onValueChange?: (value: string) => void;
    readonly getCompletion?: (value: string) => string | null;
}

// Keys we deliberately handle vs. defer:
//   - Shift+Tab: owned by App (mode cycle) — we ignore.
//   - Tab (no shift): tab-completion via getCompletion when provided.
//   - Ctrl+C: Ink default exit.
// Shift+Enter for newline depends on the terminal sending a distinguishable
// sequence (key.shift) — works in iTerm2/kitty with the right config; on
// terminals that fold Shift+Enter into plain Enter, Alt/Option+Enter (key.meta)
// is the fallback.
export const ChatInput = ({ onSubmit, disabled, onValueChange, getCompletion }: ChatInputProps) => {
    const [value, setValue] = useState("");
    const [cursor, setCursor] = useState(0);

    useEffect(() => {
        onValueChange?.(value);
    }, [value, onValueChange]);

    useInput((input, key) => {
        if (disabled) return;
        if (key.tab) {
            if (!key.shift && getCompletion) {
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
                setValue((v) => v.slice(0, cursor) + "\n" + v.slice(cursor));
                setCursor((c) => c + 1);
                return;
            }
            const trimmed = value.trim();
            if (trimmed.length === 0) return;
            onSubmit(value);
            setValue("");
            setCursor(0);
            return;
        }

        if (key.backspace || key.delete) {
            if (cursor === 0) return;
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
        if (key.upArrow || key.downArrow || key.escape || key.ctrl || key.pageUp || key.pageDown) {
            return;
        }

        if (input.length > 0) {
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
};

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
