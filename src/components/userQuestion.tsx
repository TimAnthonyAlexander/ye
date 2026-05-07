import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface UserQuestionPayload {
    readonly question: string;
    readonly options: readonly string[];
    readonly multiSelect: boolean;
}

interface UserQuestionProps {
    readonly payload: UserQuestionPayload;
    readonly onRespond: (answer: string) => void;
}

export const UserQuestion = ({ payload, onRespond }: UserQuestionProps) => {
    const [active, setActive] = useState(0);
    const [picked, setPicked] = useState<readonly boolean[]>(
        () => payload.options.map(() => false),
    );

    useInput((input, key) => {
        if (key.upArrow) {
            setActive((i) => (i - 1 + payload.options.length) % payload.options.length);
            return;
        }
        if (key.downArrow) {
            setActive((i) => (i + 1) % payload.options.length);
            return;
        }
        if (key.escape) {
            onRespond("");
            return;
        }
        if (key.return) {
            if (payload.multiSelect) {
                const chosen = payload.options.filter((_, i) => picked[i]);
                if (chosen.length === 0) {
                    const fallback = payload.options[active];
                    if (fallback !== undefined) onRespond(fallback);
                    return;
                }
                onRespond(chosen.join(", "));
                return;
            }
            const choice = payload.options[active];
            if (choice !== undefined) onRespond(choice);
            return;
        }
        if (input === " " && payload.multiSelect) {
            setPicked((prev) => prev.map((v, i) => (i === active ? !v : v)));
            return;
        }
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n >= 1 && n <= payload.options.length) {
            const choice = payload.options[n - 1];
            if (choice !== undefined && !payload.multiSelect) {
                onRespond(choice);
            } else if (choice !== undefined) {
                setPicked((prev) => prev.map((v, i) => (i === n - 1 ? !v : v)));
            }
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
                {payload.question}
            </Text>
            {payload.options.map((opt, i) => {
                const isActive = i === active;
                const isPicked = picked[i] === true;
                const prefix = payload.multiSelect ? (isPicked ? "[x]" : "[ ]") : isActive ? "▸" : " ";
                return (
                    <Box key={i}>
                        <Text color={isActive ? "cyan" : undefined}>
                            {prefix} {i + 1}. {opt}
                        </Text>
                    </Box>
                );
            })}
            <Text dimColor>
                {payload.multiSelect
                    ? "↑↓ move · space toggles · Enter submits · Esc cancels"
                    : "↑↓ move · 1–4 picks · Enter submits · Esc cancels"}
            </Text>
        </Box>
    );
};
