import { Box, Text } from "ink";
import type { PermissionMode } from "../config/index.ts";
import { modeColor } from "../ui/keybinds.ts";
import type { UpdateStatus } from "../update/check.ts";

interface TokenUsage {
    readonly input: number;
    readonly output: number;
    readonly cached?: number;
    readonly costUsd?: number;
}

interface StatusBarProps {
    readonly mode: PermissionMode;
    readonly providerId: string;
    readonly model: string;
    readonly streaming: boolean;
    readonly queuedCount?: number;
    readonly usedTokens: number;
    readonly contextWindow: number;
    readonly updateStatus?: UpdateStatus | null;
    readonly tokenUsage?: TokenUsage;
    readonly sessionTokenUsage?: TokenUsage;
}

const usageColor = (pct: number): string => {
    if (pct < 50) return "green";
    if (pct < 75) return "yellow";
    if (pct < 90) return "#ff8800";
    return "red";
};

const formatPct = (pct: number): string => {
    if (pct < 1) return "0%";
    return `${Math.round(pct)}%`;
};

const formatK = (n: number): string => {
    if (n < 1000) return String(n);
    if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
    if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
    if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    return `${Math.round(n / 1_000_000)}M`;
};

const formatUsd = (n: number): string => {
    if (n < 0.01) return `$${n.toFixed(4)}`;
    if (n < 1) return `$${n.toFixed(3)}`;
    if (n < 100) return `$${n.toFixed(2)}`;
    return `$${Math.round(n)}`;
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
    tokenUsage,
    sessionTokenUsage,
}: StatusBarProps) => {
    const pct = contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0;
    const showUpdate = updateStatus?.hasUpdate === true;
    const showSession =
        sessionTokenUsage !== undefined &&
        (sessionTokenUsage.input > 0 || sessionTokenUsage.output > 0);
    const showLifetime =
        tokenUsage !== undefined && (tokenUsage.input > 0 || tokenUsage.output > 0);
    return (
        <Box flexDirection="column">
            <Box justifyContent="space-between" paddingX={1}>
                <Box>
                    <Text color={usageColor(pct)}>{formatPct(pct)}</Text>
                    {showSession && (
                        <>
                            <Text dimColor> | </Text>
                            <Text>
                                ↑{formatK(sessionTokenUsage.input)} ↓
                                {formatK(sessionTokenUsage.output)}
                            </Text>
                            {sessionTokenUsage.cached !== undefined &&
                                sessionTokenUsage.cached > 0 && (
                                    <Text color="#888888">
                                        {" "}
                                        ↻{formatK(sessionTokenUsage.cached)}
                                    </Text>
                                )}
                            {sessionTokenUsage.costUsd !== undefined &&
                                sessionTokenUsage.costUsd > 0 && (
                                    <Text> {formatUsd(sessionTokenUsage.costUsd)}</Text>
                                )}
                        </>
                    )}
                    {showLifetime && (
                        <>
                            <Text dimColor> | all-time </Text>
                            <Text dimColor>
                                ↑{formatK(tokenUsage.input)} ↓{formatK(tokenUsage.output)}
                            </Text>
                            {tokenUsage.cached !== undefined && tokenUsage.cached > 0 && (
                                <Text color="#888888"> ↻{formatK(tokenUsage.cached)}</Text>
                            )}
                            {tokenUsage.costUsd !== undefined && tokenUsage.costUsd > 0 && (
                                <Text dimColor> {formatUsd(tokenUsage.costUsd)}</Text>
                            )}
                        </>
                    )}
                    {showUpdate && (
                        <>
                            <Text dimColor> | </Text>
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
                        ✦ {providerId} | {model}
                    </Text>
                </Box>
            </Box>
            <Box paddingX={1}>
                <Text bold color={modeColor(mode)}>
                    {mode}
                </Text>
            </Box>
        </Box>
    );
};
