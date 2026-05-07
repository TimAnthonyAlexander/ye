import { Box, Text } from "ink";
import type { PermissionMode } from "../config/index.ts";
import { modeColor } from "../ui/keybinds.ts";

interface StatusBarProps {
    readonly mode: PermissionMode;
    readonly model: string;
    readonly streaming: boolean;
}

export const StatusBar = ({ mode, model, streaming }: StatusBarProps) => {
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
                <Text dimColor>{model}</Text>
            </Box>
        </Box>
    );
};
