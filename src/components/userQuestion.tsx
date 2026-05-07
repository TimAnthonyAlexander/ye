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
    description: "Free-form answer — start typing when selected",
};

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
    const [text, setText] = useState("");

    const isTypeOption = (i: number): boolean => i === typeIndex;
    const labelAt = (i: number): string => allOptions[i]?.label ?? "";
    const onTypeOption = active === typeIndex;

    useInput((input, key) => {
        if (key.escape) {
            onRespond(DISMISS_NOTICE);
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
            if (onTypeOption) {
                const trimmed = text.trim();
                if (trimmed.length === 0) return;
                onRespond(text);
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

        if (key.backspace || key.delete) {
            if (onTypeOption) setText((t) => t.slice(0, -1));
            return;
        }

        // Mode-dependent character handling.
        // On the type option: every printable character extends the text buffer.
        // On a normal option: number keys jump-select; space toggles in multiSelect.
        if (onTypeOption) {
            if (
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

        if (input === " " && payload.multiSelect) {
            setPicked((prev) => prev.map((v, i) => (i === active ? !v : v)));
            return;
        }
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n >= 1 && n <= allOptions.length) {
            const idx = n - 1;
            if (isTypeOption(idx)) {
                setActive(idx);
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

    const helper = onTypeOption
        ? text.length > 0
            ? `Typing · Enter sends · ↑↓ moves to other options · Esc dismisses`
            : `Type to compose · Enter sends · ↑↓ picks an option · Esc dismisses`
        : payload.multiSelect
          ? `↑↓ move · 1–${allOptions.length} picks · space toggles · Enter sends · Esc dismisses`
          : `↑↓ move · 1–${allOptions.length} picks · Enter sends · Esc dismisses`;

    const renderTypeBody = (isActive: boolean): React.ReactNode => {
        if (text.length === 0) {
            if (isActive) {
                return (
                    <Text>
                        <Text inverse> </Text>
                        <Text dimColor> {TYPE_OPTION.label}</Text>
                    </Text>
                );
            }
            return <Text dimColor>{TYPE_OPTION.label}</Text>;
        }
        if (isActive) {
            return (
                <Text>
                    {text}
                    <Text inverse> </Text>
                </Text>
            );
        }
        return <Text dimColor>{text}</Text>;
    };

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
                const inMultiBox = payload.multiSelect && !isTypeOption(i);
                const prefix = inMultiBox ? (isPicked ? "[x]" : "[ ]") : isActive ? "▸" : " ";
                const indexLabel = `${i + 1}.`;

                return (
                    <Box key={i} flexDirection="column">
                        <Box>
                            <Text color={isActive ? "cyan" : undefined}>
                                {prefix} {indexLabel}{" "}
                            </Text>
                            {isTypeOption(i) ? (
                                renderTypeBody(isActive)
                            ) : (
                                <Text color={isActive ? "cyan" : undefined}>{opt.label}</Text>
                            )}
                        </Box>
                        {opt.description && !isTypeOption(i) && (
                            <Box paddingLeft={6}>
                                <Text dimColor>{opt.description}</Text>
                            </Box>
                        )}
                    </Box>
                );
            })}
            <Text dimColor>{helper}</Text>
        </Box>
    );
};
