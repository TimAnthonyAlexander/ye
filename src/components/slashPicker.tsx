import { Box, Text } from "ink";
import type { SlashCommand } from "../commands/index.ts";

interface SlashPickerProps {
    readonly matches: readonly SlashCommand[];
    readonly activeIndex: number;
}

const MAX_VISIBLE = 5;

export const windowStart = (total: number, active: number, max: number): number => {
    if (total <= max) return 0;
    const half = Math.floor(max / 2);
    return Math.min(Math.max(0, active - half), total - max);
};

export const SlashPicker = ({ matches, activeIndex }: SlashPickerProps) => {
    if (matches.length === 0) return null;

    const safeActive = Math.min(Math.max(activeIndex, 0), matches.length - 1);
    const start = windowStart(matches.length, safeActive, MAX_VISIBLE);
    const end = Math.min(matches.length, start + MAX_VISIBLE);
    const above = start;
    const below = matches.length - end;

    return (
        <Box flexDirection="column" marginBottom={1}>
            {above > 0 && <Text dimColor>↑ {above} more</Text>}
            {matches.slice(start, end).map((cmd, i) => {
                const isActive = start + i === safeActive;
                return (
                    <Box key={cmd.name}>
                        <Text color={isActive ? "cyan" : undefined}>{isActive ? "▸ " : "  "}</Text>
                        <Text color="cyan" bold={isActive}>
                            /{cmd.name}
                        </Text>
                        <Text dimColor> · {cmd.description}</Text>
                    </Box>
                );
            })}
            {below > 0 && <Text dimColor>↓ {below} more</Text>}
            <Text dimColor>↑↓ move · Enter/Tab complete · Esc dismiss</Text>
        </Box>
    );
};
