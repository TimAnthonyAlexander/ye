import { Box, Text } from "ink";
import type { PermissionMode } from "../config/index.ts";
import { modeColor } from "../ui/keybinds.ts";

interface StatusBarProps {
    readonly mode: PermissionMode;
    readonly model: string;
    readonly streaming: boolean;
    readonly queuedCount?: number;
}

export const StatusBar = ({ mode, model, streaming, queuedCount = 0 }: StatusBarProps) => {
    return (
        <Box justifyContent="space-between" paddingX={1}>
            <Box>
                <Text bold color={modeColor(mode)}>
                    {mode}
                </Text>
                <Text dimColor> · Shift+Tab cycles · Enter sends · Shift+Enter newline</Text>
            </Box>
            <Box>
                {streaming && <Text color="yellow">streaming </Text>}
                {queuedCount > 0 && <Text color="cyan">+{queuedCount} queued </Text>}
                <Text dimColor>{model}</Text>
            </Box>
        </Box>
    );
};
