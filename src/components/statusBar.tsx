import { Box, Text } from "ink";
import type { PermissionMode } from "../config/index.ts";
import { modeColor } from "../ui/keybinds.ts";
import type { UpdateStatus } from "../update/check.ts";

interface StatusBarProps {
    readonly mode: PermissionMode;
    readonly providerId: string;
    readonly model: string;
    readonly streaming: boolean;
    readonly queuedCount?: number;
    readonly usedTokens: number;
    readonly contextWindow: number;
    readonly updateStatus?: UpdateStatus | null;
}

const usageColor = (pct: number): string => {
    if (pct < 50) return "green";
    if (pct < 75) return "yellow";
    if (pct < 90) return "#ff8800";
    return "red";
};

const formatPct = (pct: number): string => {
    if (pct <= 0) return "0%";
    if (pct < 1) return "<1%";
    return `${Math.round(pct)}%`;
};

export const StatusBar = ({
    mode,
    providerId,
    model,
    streaming,
    queuedCount = 0,
    usedTokens,
    contextWindow,
    updateStatus,
}: StatusBarProps) => {
    const pct = contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0;
    const showUpdate = updateStatus?.hasUpdate === true;
    return (
        <Box justifyContent="space-between" paddingX={1}>
            <Box>
                <Text bold color={modeColor(mode)}>
                    {mode}
                </Text>
                <Text dimColor> · Shift+Tab cycles · </Text>
                <Text color={usageColor(pct)}>{formatPct(pct)} context</Text>
                {showUpdate && (
                    <>
                        <Text dimColor> · </Text>
                        <Text color="cyan">
                            update {updateStatus.current} → {updateStatus.latest} (ye --update)
                        </Text>
                    </>
                )}
            </Box>
            <Box>
                {streaming && <Text color="yellow">streaming </Text>}
                {queuedCount > 0 && <Text color="cyan">+{queuedCount} queued </Text>}
                <Text dimColor>
                    {providerId} · {model}
                </Text>
            </Box>
        </Box>
    );
};
