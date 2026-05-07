import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { UserQuestionOption } from "../tools/index.ts";

export interface UserQuestionPayload {
    readonly question: string;
    readonly options: readonly UserQuestionOption[];
    readonly multiSelect: boolean;
}

interface UserQuestionProps {
    readonly payload: UserQuestionPayload;
    readonly onRespond: (answer: string) => void;
}

const TYPE_OPTION: UserQuestionOption = {
    label: "Type something…",
    description: "Type a free-form answer in your own words",
};

// Sent back to the model when the user presses Esc. The text tells the model
// to stop calling tools and wait for the user's next message in the main input.
const DISMISS_NOTICE =
    "User dismissed the question. They will reply directly via the main chat input. " +
    "Acknowledge briefly in plain text and stop calling tools so they can respond.";

export const UserQuestion = ({ payload, onRespond }: UserQuestionProps) => {
    const allOptions = useMemo<readonly UserQuestionOption[]>(
        () => [...payload.options, TYPE_OPTION],
        [payload.options],
    );
    const typeIndex = payload.options.length;

    const [active, setActive] = useState(0);
    const [picked, setPicked] = useState<readonly boolean[]>(() =>
        payload.options.map(() => false),
    );
    const [textMode, setTextMode] = useState(false);
    const [text, setText] = useState("");

    const isTypeOption = (i: number): boolean => i === typeIndex;
    const labelAt = (i: number): string => allOptions[i]?.label ?? "";

    useInput((input, key) => {
        if (key.escape) {
            onRespond(DISMISS_NOTICE);
            return;
        }

        if (textMode) {
            if (key.return) {
                const trimmed = text.trim();
                if (trimmed.length === 0) return;
                onRespond(text);
                return;
            }
            if (key.backspace || key.delete) {
                setText((t) => t.slice(0, -1));
                return;
            }
            if (
                key.upArrow ||
                key.downArrow ||
                key.leftArrow ||
                key.rightArrow ||
                key.tab ||
                key.ctrl ||
                key.meta ||
                key.pageUp ||
                key.pageDown
            ) {
                return;
            }
            if (input.length > 0) setText((t) => t + input);
            return;
        }

        if (key.upArrow) {
            setActive((i) => (i - 1 + allOptions.length) % allOptions.length);
            return;
        }
        if (key.downArrow) {
            setActive((i) => (i + 1) % allOptions.length);
            return;
        }
        if (key.return) {
            if (isTypeOption(active)) {
                setTextMode(true);
                return;
            }
            if (payload.multiSelect) {
                const chosen = payload.options
                    .map((o, i) => (picked[i] ? o.label : null))
                    .filter((s): s is string => s !== null);
                if (chosen.length === 0) {
                    const fallback = labelAt(active);
                    if (fallback) onRespond(fallback);
                    return;
                }
                onRespond(chosen.join(", "));
                return;
            }
            const choice = labelAt(active);
            if (choice) onRespond(choice);
            return;
        }
        if (input === " " && payload.multiSelect && !isTypeOption(active)) {
            setPicked((prev) => prev.map((v, i) => (i === active ? !v : v)));
            return;
        }
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n >= 1 && n <= allOptions.length) {
            const idx = n - 1;
            if (isTypeOption(idx)) {
                setActive(idx);
                setTextMode(true);
                return;
            }
            if (!payload.multiSelect) {
                const label = labelAt(idx);
                if (label) onRespond(label);
            } else {
                setPicked((prev) => prev.map((v, i) => (i === idx ? !v : v)));
            }
        }
    });

    const helper = textMode
        ? "Enter sends · Esc dismisses (you'll type in the main input)"
        : payload.multiSelect
          ? `↑↓ move · 1–${allOptions.length} picks · space toggles · Enter sends · Esc dismisses`
          : `↑↓ move · 1–${allOptions.length} picks · Enter sends · Esc dismisses`;

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={1}
            marginBottom={1}
        >
            <Text bold color="cyan">
                {payload.question}
            </Text>
            {allOptions.map((opt, i) => {
                const isActive = i === active;
                const isPicked = picked[i] === true;
                const inMultiBox =
                    payload.multiSelect && !isTypeOption(i);
                const prefix = inMultiBox ? (isPicked ? "[x]" : "[ ]") : isActive ? "▸" : " ";
                return (
                    <Box key={i} flexDirection="column">
                        <Box>
                            <Text color={isActive ? "cyan" : undefined}>
                                {prefix} {i + 1}. {opt.label}
                            </Text>
                        </Box>
                        {opt.description && (
                            <Box paddingLeft={6}>
                                <Text dimColor>{opt.description}</Text>
                            </Box>
                        )}
                    </Box>
                );
            })}
            {textMode && (
                <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
                    <Text color="cyan">›{" "}</Text>
                    <Text>
                        {text}
                        <Text inverse> </Text>
                    </Text>
                </Box>
            )}
            <Text dimColor>{helper}</Text>
        </Box>
    );
};
