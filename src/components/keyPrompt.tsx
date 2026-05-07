import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { KeyPromptPayload } from "../providers/index.ts";

interface KeyPromptProps {
    readonly payload: KeyPromptPayload;
    readonly onRespond: (key: string | null) => void;
}

const MASK_CHAR = "•";

// Single-line masked input for sensitive values (API keys). Ink runs stdin in
// raw mode via useInput, so the terminal does not echo paste — this component
// fully controls what the user sees. Asterisks-with-length is real defense:
// glances at the screen reveal nothing, screenshots reveal nothing, paste in
// front of a coworker reveals nothing.
//
// Intentional non-features: no mid-string cursor, no arrow-key navigation. Keys
// aren't edited mid-string in practice; if they typo'd, Esc and re-launch.
export const KeyPrompt = ({ payload, onRespond }: KeyPromptProps) => {
    const [buffer, setBuffer] = useState("");

    useInput((input, key) => {
        if (key.escape) {
            onRespond(null);
            return;
        }
        if (key.return) {
            const trimmed = buffer.trim();
            if (trimmed.length === 0) return;
            onRespond(trimmed);
            return;
        }
        if (key.backspace || key.delete) {
            setBuffer((b) => b.slice(0, -1));
            return;
        }
        // Suppress navigation / modifier-only chords. Plain characters and
        // pasted strings (Ink delivers paste as a single multi-char `input`)
        // append to the buffer.
        if (
            key.leftArrow ||
            key.rightArrow ||
            key.upArrow ||
            key.downArrow ||
            key.tab ||
            key.ctrl ||
            key.meta ||
            key.pageUp ||
            key.pageDown
        ) {
            return;
        }
        if (input.length > 0) {
            setBuffer((b) => b + input);
        }
    });

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={1}
            marginBottom={1}
        >
            <Text bold color="cyan">
                {payload.title}
            </Text>
            <Text dimColor>{payload.description}</Text>
            <Box marginTop={1}>
                <Text color="cyan">›</Text>
                <Text> {MASK_CHAR.repeat(buffer.length)}</Text>
                <Text inverse> </Text>
            </Box>
            <Text dimColor>
                {buffer.length} {buffer.length === 1 ? "char" : "chars"} · Enter saves · Esc
                cancels
            </Text>
        </Box>
    );
};
