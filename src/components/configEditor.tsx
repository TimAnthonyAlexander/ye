import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { editFor, type ConfigEdit } from "../config/edit.ts";
import {
    adjust,
    formatValue,
    isSelectableRow,
    isTypeable,
    parseInput,
    type ConfigRow,
    type ConfigValue,
    type FieldRow,
} from "../config/registry.ts";

const MAX_VISIBLE = 14;

export interface ConfigEditorProps {
    readonly rows: readonly ConfigRow[];
    // `null` means the user discarded everything.
    readonly onClose: (edits: readonly ConfigEdit[] | null) => void;
}

interface Editing {
    readonly path: string;
    readonly text: string;
}

const firstSelectable = (rows: readonly ConfigRow[]): number => {
    const index = rows.findIndex(isSelectableRow);
    return index < 0 ? 0 : index;
};

const nextSelectable = (rows: readonly ConfigRow[], from: number, direction: 1 | -1): number => {
    const len = rows.length;
    if (len === 0) return 0;
    for (let step = 1; step <= len; step++) {
        const i = (((from + direction * step) % len) + len) % len;
        const row = rows[i];
        if (row && isSelectableRow(row)) return i;
    }
    return from;
};

const truncate = (text: string, width: number): string =>
    text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;

export const ConfigEditor = ({ rows, onClose }: ConfigEditorProps) => {
    const [active, setActive] = useState(() => firstSelectable(rows));
    const [changes, setChanges] = useState<ReadonlyMap<string, ConfigValue | undefined>>(
        () => new Map(),
    );
    const [editing, setEditing] = useState<Editing | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const { stdout } = useStdout();
    const [columns, setColumns] = useState(stdout?.columns ?? 80);
    useEffect(() => {
        if (!stdout) return;
        const onResize = (): void => setColumns(stdout.columns ?? 80);
        stdout.on("resize", onResize);
        return () => {
            stdout.off("resize", onResize);
        };
    }, [stdout]);

    const labelWidth =
        rows.reduce((width, row) => {
            if (row.kind === "field") return Math.max(width, row.field.label.length);
            if (row.kind === "info") return Math.max(width, row.label.length);
            return width;
        }, 0) + 2;
    const valueWidth = Math.max(16, columns - labelWidth - 22);

    const lastWindowStart = useRef(0);
    let windowStart = lastWindowStart.current;
    if (rows.length <= MAX_VISIBLE) {
        windowStart = 0;
    } else {
        if (active < windowStart) windowStart = active;
        if (active >= windowStart + MAX_VISIBLE) windowStart = active - MAX_VISIBLE + 1;
        windowStart = Math.max(0, Math.min(windowStart, rows.length - MAX_VISIBLE));
    }
    lastWindowStart.current = windowStart;
    const windowEnd = Math.min(rows.length, windowStart + MAX_VISIBLE);
    const windowed = rows.slice(windowStart, windowEnd);

    const valueOf = (row: FieldRow): ConfigValue | undefined =>
        changes.has(row.field.path) ? changes.get(row.field.path) : row.value;

    const setValue = (row: FieldRow, next: ConfigValue | undefined): void => {
        setChanges((prev) => {
            const map = new Map(prev);
            if (next === row.value) map.delete(row.field.path);
            else map.set(row.field.path, next);
            return map;
        });
    };

    const collectEdits = (): readonly ConfigEdit[] =>
        rows
            .filter(isSelectableRow)
            .filter((row) => changes.has(row.field.path))
            .map((row) => editFor(row, changes.get(row.field.path)));

    useInput((input, key) => {
        if (key.ctrl && input === "c") {
            onClose(null);
            return;
        }

        const row = rows[active];
        const current = row && isSelectableRow(row) ? row : null;

        if (editing !== null) {
            if (key.escape) {
                setEditing(null);
                setNotice(null);
                return;
            }
            if (key.return) {
                if (current === null) {
                    setEditing(null);
                    return;
                }
                const parsed = parseInput(current.field, editing.text);
                if (!parsed.ok) {
                    setNotice(parsed.message);
                    return;
                }
                setValue(current, parsed.value);
                setEditing(null);
                setNotice(null);
                return;
            }
            if (key.backspace || key.delete) {
                setEditing({ ...editing, text: editing.text.slice(0, -1) });
                return;
            }
            if (key.ctrl || key.meta || key.upArrow || key.downArrow) return;
            if (input.length > 0) setEditing({ ...editing, text: editing.text + input });
            return;
        }

        if (key.escape) {
            onClose(collectEdits());
            return;
        }
        if (key.upArrow) {
            setActive((i) => nextSelectable(rows, i, -1));
            setNotice(null);
            return;
        }
        if (key.downArrow) {
            setActive((i) => nextSelectable(rows, i, 1));
            setNotice(null);
            return;
        }
        if (current === null) return;
        if (key.leftArrow || key.rightArrow) {
            setValue(current, adjust(current.field, valueOf(current), key.rightArrow ? 1 : -1));
            return;
        }
        if (key.return && isTypeable(current.field)) {
            const value = valueOf(current);
            setEditing({
                path: current.field.path,
                text: value === undefined ? "" : String(value),
            });
            setNotice(null);
        }
    });

    const activeRow = rows[active];
    const description = activeRow && isSelectableRow(activeRow) ? activeRow.field.description : "";
    const pending = changes.size;

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={1}
            marginBottom={1}
        >
            <Text bold color="cyan">
                Settings
            </Text>
            {windowStart > 0 && <Text dimColor>↑ {windowStart} more</Text>}
            {windowed.map((row, indexInWindow) => {
                const i = windowStart + indexInWindow;
                if (row.kind === "header") {
                    return (
                        <Text key={`h-${row.label}`} dimColor bold>
                            {row.label}
                        </Text>
                    );
                }
                if (row.kind === "info") {
                    return (
                        <Box key={`i-${row.section}-${row.label}`}>
                            <Text dimColor>{`   ${row.label.padEnd(labelWidth)}`}</Text>
                            <Text dimColor>
                                {truncate(row.value, valueWidth).padEnd(valueWidth)}
                            </Text>
                            <Text dimColor> ({row.note})</Text>
                        </Box>
                    );
                }
                const isActive = i === active;
                const changed = changes.has(row.field.path);
                const value = valueOf(row);
                const isEditing = editing !== null && editing.path === row.field.path;
                return (
                    <Box key={row.field.path}>
                        <Text color={isActive ? "cyan" : undefined}>
                            {isActive ? "▸" : " "}
                            {changed ? "·" : " "}{" "}
                        </Text>
                        <Text color={isActive ? "cyan" : undefined}>
                            {row.field.label.padEnd(labelWidth)}
                        </Text>
                        {isEditing ? (
                            <>
                                <Text>{editing.text}</Text>
                                <Text inverse> </Text>
                            </>
                        ) : (
                            <>
                                <Text dimColor={value === undefined}>
                                    {truncate(formatValue(value), valueWidth).padEnd(valueWidth)}
                                </Text>
                                <Text dimColor> ({changed ? "pending" : row.origin})</Text>
                            </>
                        )}
                    </Box>
                );
            })}
            {rows.length - windowEnd > 0 && <Text dimColor>↓ {rows.length - windowEnd} more</Text>}
            <Box marginTop={1} flexDirection="column">
                {notice !== null ? (
                    <Text color="red">{notice}</Text>
                ) : (
                    <Text dimColor>{description}</Text>
                )}
                <Text dimColor>
                    {editing !== null
                        ? "type a value · Enter accepts · Esc cancels"
                        : `↑↓ move · ←→ change · Enter edits · Esc saves${pending > 0 ? ` (${pending} pending)` : ""} · Ctrl+C discards`}
                </Text>
            </Box>
        </Box>
    );
};
