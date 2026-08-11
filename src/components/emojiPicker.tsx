import { Box, Text } from "ink";

interface EmojiPickerProps {
    readonly matches: readonly { char: string; code: string }[];
    readonly activeIndex: number;
}

const MAX_VISIBLE = 4;

export const EmojiPicker = ({ matches, activeIndex }: EmojiPickerProps) => {
    if (matches.length === 0) return null;

    const visible = matches.slice(0, MAX_VISIBLE);
    const safeActive =
        visible.length === 0 ? 0 : Math.min(Math.max(activeIndex, 0), visible.length - 1);
    const pad = MAX_VISIBLE - visible.length;

    return (
        <Box flexDirection="column" marginBottom={1}>
            {visible.map((opt, i) => {
                const isActive = i === safeActive;
                const prefix = isActive ? "▸ " : "  ";
                return (
                    <Box key={opt.char}>
                        <Text color={isActive ? "yellow" : undefined}>{prefix}</Text>
                        <Text bold={isActive}>{opt.char}</Text>
                        <Text color={isActive ? "cyan" : undefined} dimColor={!isActive}>
                            {" "}
                            :{opt.code}
                        </Text>
                    </Box>
                );
            })}
            {pad > 0 &&
                Array.from({ length: pad }, (_, i) => (
                    <Box key={`pad-${i}`}>
                        <Text> </Text>
                    </Box>
                ))}
            <Text dimColor>↑↓ pick · Enter insert · Esc cancel</Text>
        </Box>
    );
};
