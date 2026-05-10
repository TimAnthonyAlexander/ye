import { Box, Text, useInput } from "ink";
import { useMemo, useRef, useState } from "react";

// Visible-window cap. Pickers with more matches scroll within the window;
// "↑ N more" / "↓ N more" hints flag the offscreen items.
const MAX_VISIBLE = 8;

export interface PickerOption {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly kind?: "item" | "header";
}

export interface PickerPayload {
    readonly title: string;
    readonly options: readonly PickerOption[];
    readonly initialId?: string;
}

interface PickerProps {
    readonly payload: PickerPayload;
    readonly onRespond: (id: string | null) => void;
}

const isSelectable = (opt: PickerOption): boolean => opt.kind !== "header";

// Case-insensitive substring match on label + id + description. Picks are small
// (handful of providers, handful of models), so a true fuzzy matcher would add
// dependency weight without changing the user experience. Headers vanish when
// the user is filtering — they're scoping aids, not matches.
const matches = (query: string, opt: PickerOption): boolean => {
    if (opt.kind === "header") return query.length === 0;
    if (query.length === 0) return true;
    const q = query.toLowerCase();
    const hay = `${opt.label} ${opt.id} ${opt.description ?? ""}`.toLowerCase();
    return hay.includes(q);
};

const findNextSelectable = (
    list: readonly PickerOption[],
    from: number,
    direction: 1 | -1,
): number => {
    if (list.length === 0) return 0;
    const len = list.length;
    for (let step = 1; step <= len; step++) {
        const i = (((from + direction * step) % len) + len) % len;
        if (isSelectable(list[i] as PickerOption)) return i;
    }
    return from;
};

const initialActiveIndex = (payload: PickerPayload): number => {
    const opts = payload.options;
    if (opts.length === 0) return 0;
    if (payload.initialId) {
        const idx = opts.findIndex((o) => o.id === payload.initialId);
        if (idx >= 0 && isSelectable(opts[idx] as PickerOption)) return idx;
    }
    // Fall back to the first selectable row.
    for (let i = 0; i < opts.length; i++) {
        if (isSelectable(opts[i] as PickerOption)) return i;
    }
    return 0;
};

export const Picker = ({ payload, onRespond }: PickerProps) => {
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(() => initialActiveIndex(payload));

    const filtered = useMemo(
        () => payload.options.filter((o) => matches(query.trim(), o)),
        [payload.options, query],
    );

    const safeActive = filtered.length === 0 ? 0 : Math.min(active, filtered.length - 1);

    // Sticky scroll window: shifts only when the cursor would otherwise leave
    // it. Storing in a ref (not state) avoids extra renders — refs aren't
    // reactive, but the next render computes a fresh windowStart from the
    // up-to-date safeActive. Mutating during render is fine here since the
    // ref isn't read by anything React tracks.
    const lastWindowStart = useRef(0);
    let windowStart = lastWindowStart.current;
    if (filtered.length <= MAX_VISIBLE) {
        windowStart = 0;
    } else {
        if (safeActive < windowStart) windowStart = safeActive;
        if (safeActive >= windowStart + MAX_VISIBLE) {
            windowStart = safeActive - MAX_VISIBLE + 1;
        }
        windowStart = Math.max(0, Math.min(windowStart, filtered.length - MAX_VISIBLE));
    }
    lastWindowStart.current = windowStart;
    const windowEnd = Math.min(filtered.length, windowStart + MAX_VISIBLE);
    const windowed = filtered.slice(windowStart, windowEnd);
    const itemsBefore = windowStart;
    const itemsAfter = filtered.length - windowEnd;

    useInput((input, key) => {
        if (key.escape) {
            onRespond(null);
            return;
        }

        if (key.upArrow) {
            if (filtered.length === 0) return;
            setActive((i) => {
                const cur = Math.min(i, filtered.length - 1);
                return findNextSelectable(filtered, cur, -1);
            });
            return;
        }
        if (key.downArrow) {
            if (filtered.length === 0) return;
            setActive((i) => {
                const cur = Math.min(i, filtered.length - 1);
                return findNextSelectable(filtered, cur, 1);
            });
            return;
        }

        if (key.return) {
            const choice = filtered[safeActive];
            if (choice && isSelectable(choice)) onRespond(choice.id);
            return;
        }

        if (key.backspace || key.delete) {
            setQuery((q) => q.slice(0, -1));
            setActive(0);
            return;
        }

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

        if (input.length > 0) {
            setQuery((q) => q + input);
            setActive(0);
        }
    });

    const helper = `↑↓ move · type to filter · Enter selects · Esc cancels`;

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={1}
            marginBottom={1}
        >
            <Text bold color="cyan">
                {payload.title}
            </Text>
            <Box>
                <Text color="cyan">›</Text>
                <Text> {query}</Text>
                <Text inverse> </Text>
            </Box>
            {filtered.length === 0 ? (
                <Text dimColor>(no matches)</Text>
            ) : (
                <>
                    {itemsBefore > 0 && <Text dimColor>↑ {itemsBefore} more</Text>}
                    {windowed.map((opt, idxInWindow) => {
                        if (opt.kind === "header") {
                            return (
                                <Box key={opt.id}>
                                    <Text dimColor bold>
                                        ── {opt.label} ──
                                    </Text>
                                </Box>
                            );
                        }
                        const i = windowStart + idxInWindow;
                        const isActive = i === safeActive;
                        const isInitial = opt.id === payload.initialId;
                        const prefix = isActive ? "▸" : " ";
                        const marker = isInitial ? "*" : " ";
                        return (
                            <Box key={opt.id} flexDirection="column">
                                <Box>
                                    <Text color={isActive ? "cyan" : undefined}>
                                        {prefix} {marker} {opt.label}
                                    </Text>
                                    {opt.label !== opt.id && <Text dimColor> — {opt.id}</Text>}
                                </Box>
                                {opt.description && (
                                    <Box paddingLeft={5}>
                                        <Text dimColor>{opt.description}</Text>
                                    </Box>
                                )}
                            </Box>
                        );
                    })}
                    {itemsAfter > 0 && <Text dimColor>↓ {itemsAfter} more</Text>}
                </>
            )}
            <Text dimColor>{helper}</Text>
        </Box>
    );
};
