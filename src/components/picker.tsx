import { Box, Text, useInput } from "ink";
import { useMemo, useRef, useState } from "react";

// Visible-window cap. Pickers with more matches scroll within the window;
// "↑ N more" / "↓ N more" hints flag the offscreen items.
const MAX_VISIBLE = 8;

export interface PickerOption {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
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

// Case-insensitive substring match on label + id + description. Picks are small
// (handful of providers, handful of models), so a true fuzzy matcher would add
// dependency weight without changing the user experience.
const matches = (query: string, opt: PickerOption): boolean => {
    if (query.length === 0) return true;
    const q = query.toLowerCase();
    const hay = `${opt.label} ${opt.id} ${opt.description ?? ""}`.toLowerCase();
    return hay.includes(q);
};

const initialActiveIndex = (payload: PickerPayload): number => {
    if (!payload.initialId) return 0;
    const idx = payload.options.findIndex((o) => o.id === payload.initialId);
    return idx >= 0 ? idx : 0;
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
                return (cur - 1 + filtered.length) % filtered.length;
            });
            return;
        }
        if (key.downArrow) {
            if (filtered.length === 0) return;
            setActive((i) => {
                const cur = Math.min(i, filtered.length - 1);
                return (cur + 1) % filtered.length;
            });
            return;
        }

        if (key.return) {
            const choice = filtered[safeActive];
            if (choice) onRespond(choice.id);
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
