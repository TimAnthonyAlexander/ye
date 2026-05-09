import { Box, Text, useInput, useStdout } from "ink";
import { memo, useEffect, useState } from "react";
import type { SessionSummary } from "../storage/index.ts";
import { formatRelativeTime } from "../ui/relativeTime.ts";
import { HomeBanner } from "./homeBanner.tsx";

const VISIBLE_INITIAL = 5;
const VISIBLE_EXPANDED = 20;
const MODAL_MAX_WIDTH = 72;
const MODAL_MIN_WIDTH = 40;

// Below these terminal sizes the modal would either crowd out the input or
// truncate its own content. App reads these to gate the Home render entirely.
export const HOME_MIN_COLS = MODAL_MIN_WIDTH + 4;
export const HOME_MIN_ROWS = 24;

interface HomeProps {
    readonly version: string;
    readonly username: string | null;
    readonly cwd: string;
    readonly providerId: string;
    readonly model: string;
    readonly recents: readonly SessionSummary[];
    readonly recentsLoaded: boolean;
    readonly tip: string;
    readonly inputEmpty: boolean;
    readonly onResume: (sessionId: string) => void;
}

const headlineFor = (s: SessionSummary): string => {
    if (s.title && s.title.length > 0) return s.title;
    if (s.preview.length > 0) return s.preview;
    return `${s.userMessageCount} msg`;
};

const truncate = (s: string, max: number): string =>
    s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

export const Home = memo(
    ({
        version,
        username,
        cwd,
        providerId,
        model,
        recents,
        recentsLoaded,
        tip,
        inputEmpty,
        onResume,
    }: HomeProps) => {
        const [selectedIndex, setSelectedIndex] = useState(-1);
        const [showMore, setShowMore] = useState(false);

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
        const modalWidth = Math.max(
            MODAL_MIN_WIDTH,
            Math.min(MODAL_MAX_WIDTH, columns - 4),
        );

        const visibleCount = Math.min(
            recents.length,
            showMore ? VISIBLE_EXPANDED : VISIBLE_INITIAL,
        );
        const visible = recents.slice(0, visibleCount);
        const hasMore = !showMore && recents.length > VISIBLE_INITIAL;

        // Clamp selection if recents shrink (e.g., after /clear refetch).
        useEffect(() => {
            if (selectedIndex >= visibleCount) {
                setSelectedIndex(visibleCount - 1);
            }
        }, [visibleCount, selectedIndex]);

        useInput(
            (_input, key) => {
                if (key.downArrow) {
                    if (visibleCount === 0) return;
                    if (selectedIndex < visibleCount - 1) {
                        setSelectedIndex(selectedIndex + 1);
                        return;
                    }
                    if (hasMore) setShowMore(true);
                    return;
                }
                if (key.upArrow) {
                    if (selectedIndex > -1) setSelectedIndex(selectedIndex - 1);
                    return;
                }
                if (key.return) {
                    if (selectedIndex < 0) return;
                    const target = visible[selectedIndex];
                    if (target) onResume(target.sessionId);
                }
            },
            { isActive: inputEmpty },
        );

        const greeting = username ? `Welcome back, ${username}.` : "Welcome to Ye.";

        return (
            <Box width="100%" justifyContent="center" paddingY={1}>
                <Box
                    flexDirection="column"
                    borderStyle="round"
                    borderColor="cyan"
                    paddingX={3}
                    paddingY={1}
                    width={modalWidth}
                >
                    <HomeBanner version={version} />

                    <Box marginTop={1} flexDirection="column" alignItems="center">
                        <Text>{greeting}</Text>
                        <Text dimColor>
                            {providerId} · {model}
                        </Text>
                        <Text dimColor>{cwd}</Text>
                    </Box>

                    <Box marginTop={1} flexDirection="column">
                        <Text bold dimColor>
                            Recent
                        </Text>
                        <RecentList
                            recentsLoaded={recentsLoaded}
                            visible={visible}
                            selectedIndex={selectedIndex}
                            hasMore={hasMore}
                            totalCount={recents.length}
                        />
                    </Box>

                    <Box marginTop={1} flexDirection="column">
                        <Text bold dimColor>
                            Tip
                        </Text>
                        <Text dimColor>{tip}</Text>
                    </Box>

                    <Box marginTop={1} justifyContent="center">
                        <Text dimColor>
                            Start typing · <Text color="cyan">↑↓</Text> pick ·{" "}
                            <Text color="cyan">↵</Text> resume ·{" "}
                            <Text color="cyan">/help</Text>
                        </Text>
                    </Box>
                </Box>
            </Box>
        );
    },
);
Home.displayName = "Home";

interface RecentListProps {
    readonly recentsLoaded: boolean;
    readonly visible: readonly SessionSummary[];
    readonly selectedIndex: number;
    readonly hasMore: boolean;
    readonly totalCount: number;
}

const RecentList = memo(
    ({ recentsLoaded, visible, selectedIndex, hasMore, totalCount }: RecentListProps) => {
        if (!recentsLoaded) {
            return <Text dimColor> loading…</Text>;
        }
        if (visible.length === 0) {
            return <Text dimColor> no sessions yet — type below to start one.</Text>;
        }
        return (
            <Box flexDirection="column">
                {visible.map((s, i) => {
                    const selected = i === selectedIndex;
                    const stamp = formatRelativeTime(s.modifiedAt);
                    const headline = truncate(headlineFor(s), 60);
                    return (
                        <Box key={s.sessionId}>
                            <Text color={selected ? "cyan" : undefined}>
                                {selected ? " ▸ " : "   "}
                            </Text>
                            <Text dimColor={!selected}>{stamp} </Text>
                            <Text color={selected ? "cyan" : undefined} bold={selected}>
                                {headline}
                            </Text>
                        </Box>
                    );
                })}
                {hasMore && (
                    <Box>
                        <Text dimColor> ↓ load {totalCount - visible.length} more</Text>
                    </Box>
                )}
            </Box>
        );
    },
);
RecentList.displayName = "RecentList";
