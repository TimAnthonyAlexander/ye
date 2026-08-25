import { Box, Text, useInput } from "ink";
import type { BackgroundSubagentTask } from "../subagents/background.ts";

interface SubagentTabBarProps {
    readonly tasks: readonly BackgroundSubagentTask[];
    readonly selectedTab: string; // "main" or task id
    readonly onSelectTab: (tab: string) => void;
    readonly onKill: (taskId: string) => void;
    readonly focused: boolean;
    readonly onFocusBack: () => void;
    // Owned by App, not here: the transcript's steer composer is live at the
    // same time as this list, so both have to agree that the confirm keystroke
    // belongs to the confirm and not to the draft.
    readonly pendingKill: string | null;
    readonly onPendingKill: (taskId: string | null) => void;
}

const kindLabel = (kind: string): string => {
    switch (kind) {
        case "explore":
            return "Explore";
        case "general":
            return "Gen";
        case "verification":
            return "Verify";
        default:
            return kind;
    }
};

const statusColor = (status: string): string | undefined => {
    switch (status) {
        case "running":
            return "yellow";
        case "completed":
            return "green";
        case "failed":
            return "red";
        case "killed":
            return "magenta";
        default:
            return undefined;
    }
};

// Where ↑/↓ land. `null` means the list is done with the keys: ↑ off the top
// row closes the panel. ↓ off the bottom stays put rather than wrapping — a
// wrap would jump from the newest agent back to the main chat, which reads as
// having left the panel by accident.
export const moveSelection = (
    tabs: readonly string[],
    selected: string,
    direction: "up" | "down",
): string | null => {
    const index = Math.max(0, tabs.indexOf(selected));
    if (direction === "up") return index === 0 ? null : (tabs[index - 1] ?? null);
    return index < tabs.length - 1 ? (tabs[index + 1] ?? selected) : selected;
};

// One row per agent, so ↑ and ↓ move the way the list looks. Selecting a row
// *is* opening it — the transcript below always shows the selected agent, and
// "main" is the row that shows the ordinary chat. That removes the separate
// browse/open modes, and with them the Esc that used to be the only way back.
export const SubagentTabBar = ({
    tasks,
    selectedTab,
    onSelectTab,
    onKill,
    focused,
    onFocusBack,
    pendingKill,
    onPendingKill,
}: SubagentTabBarProps) => {
    const tabs = ["main", ...tasks.map((t) => t.id)];
    // Stopping a long-running agent by brushing a key is unrecoverable, so the
    // kill needs a second, differently-shaped keystroke. It is a Ctrl chord
    // rather than a bare `k` because plain letters now go to the steer
    // composer of whichever agent the list has open.
    const pendingTask = pendingKill === null ? undefined : tasks.find((t) => t.id === pendingKill);

    useInput((input, key) => {
        if (!focused) return;
        if (pendingKill !== null) {
            if (input === "y" || input === "Y") onKill(pendingKill);
            onPendingKill(null);
            return;
        }
        if (key.upArrow || key.downArrow) {
            const next = moveSelection(tabs, selectedTab, key.upArrow ? "up" : "down");
            // Past the top row there is nothing left to look at, so the panel
            // closes and the keys go back to the prompt.
            if (next === null) onFocusBack();
            else if (next !== selectedTab) onSelectTab(next);
            return;
        }
        if (key.ctrl && (input === "k" || input === "\v")) {
            const task = tasks.find((t) => t.id === selectedTab);
            if (task && task.status === "running") onPendingKill(task.id);
            return;
        }
    });

    return (
        <Box flexDirection="column">
            {focused && <Text dimColor>↑↓ switch agent · ctrl+k stop · ↑ past main exits</Text>}
            {tabs.map((tab) => {
                const selected = tab === selectedTab;
                const marker = selected ? "(•)" : "( )";
                if (tab === "main") {
                    return (
                        <Box key="main">
                            <Text dimColor={!selected}>{marker} main</Text>
                        </Box>
                    );
                }
                const task = tasks.find((t) => t.id === tab);
                if (!task) return null;
                const color = statusColor(task.status);
                const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
                const elapsedStr =
                    elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;
                const queued = task.mailbox.queued().length;
                return (
                    <Box key={tab}>
                        <Text dimColor={!selected}>{marker} </Text>
                        <Text color={color}>
                            {kindLabel(task.kind)} {elapsedStr}
                        </Text>
                        <Text dimColor> · {task.status}</Text>
                        {queued > 0 && <Text color="cyan"> +{queued}</Text>}
                    </Box>
                );
            })}
            {pendingTask && (
                <Box>
                    <Text color="red">
                        stop {kindLabel(pendingTask.kind)} ({pendingTask.id})?
                    </Text>
                    <Text dimColor> y to confirm, any other key cancels</Text>
                </Box>
            )}
        </Box>
    );
};
