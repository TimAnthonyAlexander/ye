import { Box, Text } from "ink";
import { memo } from "react";
import type { ContextSnapshot, SegmentKey } from "../context/snapshot.ts";

const GRID_CELLS = 100;
const GRID_COLS = 10;
const FULL = "⛁";
const PARTIAL = "⛀";
const RESERVE = "⛝";
const FREE = "⛶";

type CellKind = SegmentKey | "reserve" | "free";

interface Cell {
    readonly kind: CellKind;
    readonly partial: boolean;
}

const SEGMENT_COLOR: Record<SegmentKey, string> = {
    system: "cyan",
    tools: "magenta",
    memory: "yellow",
    skills: "blue",
    messages: "green",
};

const CELL_COLOR: Record<CellKind, string> = {
    ...SEGMENT_COLOR,
    reserve: "red",
    free: "gray",
};

const glyphFor = (cell: Cell): string => {
    if (cell.kind === "free") return FREE;
    if (cell.kind === "reserve") return RESERVE;
    return cell.partial ? PARTIAL : FULL;
};

const formatTokens = (n: number): string => {
    if (n < 1000) return String(n);
    if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
    if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
};

const formatPct = (numerator: number, denominator: number): string => {
    if (denominator <= 0) return "0%";
    const pct = (numerator / denominator) * 100;
    if (pct < 0.05) return "<0.1%";
    if (pct < 10) return `${pct.toFixed(1)}%`;
    return `${Math.round(pct)}%`;
};

// A category gets `floor(exact)` full ⛁ cells and one partial ⛀ when its
// fractional remainder is ≥ 0.3. Categories with a tiny but nonzero share get
// at least a partial cell so they don't disappear from the grid entirely.
const segmentCells = (kind: SegmentKey, tokens: number, denom: number): readonly Cell[] => {
    if (tokens <= 0) return [];
    const exact = (tokens / denom) * GRID_CELLS;
    const full = Math.floor(exact);
    const fraction = exact - full;
    const cells: Cell[] = [];
    for (let i = 0; i < full; i++) cells.push({ kind, partial: false });
    if (fraction >= 0.3 || (full === 0 && tokens > 0)) {
        cells.push({ kind, partial: true });
    }
    return cells;
};

const buildCells = (snap: ContextSnapshot): readonly Cell[] => {
    const denom = snap.autocompactWindow;
    if (denom <= 0) {
        return Array.from({ length: GRID_CELLS }, () => ({
            kind: "free" as CellKind,
            partial: false,
        }));
    }
    const cells: Cell[] = [];
    const push = (more: readonly Cell[]): void => {
        for (const c of more) {
            if (cells.length >= GRID_CELLS) return;
            cells.push(c);
        }
    };
    for (const seg of snap.segments) push(segmentCells(seg.key, seg.tokens, denom));
    const reserveExact = (snap.outputReserve / denom) * GRID_CELLS;
    const reserveCells = Math.max(0, Math.round(reserveExact));
    const freeCells = Math.max(0, GRID_CELLS - cells.length - reserveCells);
    for (let i = 0; i < freeCells; i++) push([{ kind: "free", partial: false }]);
    while (cells.length < GRID_CELLS) push([{ kind: "reserve", partial: false }]);
    return cells.slice(0, GRID_CELLS);
};

const TIER_LABEL: Record<string, string> = {
    builtin: "builtin",
    managed: "managed",
    user: "user",
    project: "project",
    claude: "claude",
};

interface ContextPanelProps {
    readonly snapshot: ContextSnapshot;
}

export const ContextPanel = memo(({ snapshot }: ContextPanelProps) => {
    const cells = buildCells(snapshot);
    const rows: Cell[][] = [];
    for (let r = 0; r < GRID_CELLS / GRID_COLS; r++) {
        rows.push(cells.slice(r * GRID_COLS, (r + 1) * GRID_COLS));
    }
    const denom = snapshot.autocompactWindow;
    const modelHint = `${snapshot.modelLabel} (${formatTokens(snapshot.contextWindow)} context)`;

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Text bold>Context Usage</Text>
            <Box flexDirection="row" marginTop={1}>
                <Box flexDirection="column" marginRight={2}>
                    {rows.map((row, r) => (
                        <Box key={r}>
                            {row.map((cell, c) => (
                                <Text key={c} color={CELL_COLOR[cell.kind]}>
                                    {glyphFor(cell)}{" "}
                                </Text>
                            ))}
                        </Box>
                    ))}
                </Box>
                <Box flexDirection="column">
                    <Text bold>{modelHint}</Text>
                    <Text dimColor>{snapshot.model}</Text>
                    <Text>
                        {formatTokens(snapshot.totalUsed)}/{formatTokens(denom)} tokens (
                        {formatPct(snapshot.totalUsed, denom)})
                    </Text>
                    <Box marginTop={1}>
                        <Text dimColor>Estimated usage by category</Text>
                    </Box>
                    {snapshot.segments.map((seg) => (
                        <Box key={seg.key}>
                            <Text color={SEGMENT_COLOR[seg.key]}>{FULL} </Text>
                            <Text>
                                {seg.label}: {formatTokens(seg.tokens)} tokens (
                                {formatPct(seg.tokens, denom)})
                            </Text>
                        </Box>
                    ))}
                    <Box>
                        <Text color={CELL_COLOR.free}>{FREE} </Text>
                        <Text>
                            Free space: {formatTokens(snapshot.free)} (
                            {formatPct(snapshot.free, denom)})
                        </Text>
                    </Box>
                    <Box>
                        <Text color={CELL_COLOR.reserve}>{RESERVE} </Text>
                        <Text>
                            Output reserve: {formatTokens(snapshot.outputReserve)} (
                            {formatPct(snapshot.outputReserve, denom)})
                        </Text>
                    </Box>
                </Box>
            </Box>
            <Box marginTop={1}>
                <Text dimColor>
                    Auto-compact window: {formatTokens(denom)} tokens (
                    {Math.round(snapshot.autocompactThreshold * 100)}% of model max)
                </Text>
            </Box>

            {snapshot.memoryFiles.length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                    <Text bold>Memory files</Text>
                    {snapshot.memoryFiles.map((f, i) => (
                        <Text key={i} dimColor>
                            ├ {f.path}: {formatTokens(f.tokens)} tokens
                        </Text>
                    ))}
                </Box>
            )}

            {snapshot.skills.length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                    <Text bold>Skills · /help</Text>
                    {snapshot.skills.map((s, i) => (
                        <Text key={i} dimColor>
                            ├ {s.name} ({TIER_LABEL[s.tier] ?? s.tier}): {formatTokens(s.tokens)}{" "}
                            tokens
                        </Text>
                    ))}
                </Box>
            )}
        </Box>
    );
});
ContextPanel.displayName = "ContextPanel";
