import { Box, Text } from "ink";
import type { MentionOption } from "../mentions/index.ts";

interface MentionPickerProps {
    readonly matches: readonly MentionOption[];
    readonly activeIndex: number;
}

const MAX_VISIBLE = 8;

export const MentionPicker = ({ matches, activeIndex }: MentionPickerProps) => {
    if (matches.length === 0) return null;

    const visible = matches.slice(0, MAX_VISIBLE);
    const hiddenCount = matches.length - visible.length;
    const safeActive =
        visible.length === 0 ? 0 : Math.min(Math.max(activeIndex, 0), visible.length - 1);

    return (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
            {visible.map((opt, i) => {
                const isActive = i === safeActive;
                const prefix = isActive ? "▸ " : "  ";
                return (
                    <Box key={opt.id}>
                        <Text color={isActive ? "cyan" : undefined}>{prefix}</Text>
                        {opt.parent.length > 0 && <Text dimColor>{opt.parent}</Text>}
                        <Text bold={isActive} color={isActive ? "cyan" : undefined}>
                            {opt.basename}
                        </Text>
                    </Box>
                );
            })}
            {hiddenCount > 0 && <Text dimColor>…and {hiddenCount} more</Text>}
            <Text dimColor>↑↓ move · Enter/Tab insert · Esc dismiss</Text>
        </Box>
    );
};
