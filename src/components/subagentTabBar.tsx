import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { BackgroundSubagentTask } from "../subagents/background.ts";

interface SubagentTabBarProps {
    readonly tasks: readonly BackgroundSubagentTask[];
    readonly selectedTab: string; // "main" or task id
    readonly onSelectTab: (tab: string) => void;
    readonly onEnter: (tab: string) => void;
    readonly onKill: (taskId: string) => void;
    readonly focused: boolean;
    readonly onFocusBack: () => void;
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

export const SubagentTabBar = ({
    tasks,
    selectedTab,
    onSelectTab,
    onEnter,
    onKill,
    focused,
    onFocusBack,
}: SubagentTabBarProps) => {
    const tabs = ["main", ...tasks.map((t) => t.id)];
    const selectedIndex = Math.max(0, tabs.indexOf(selectedTab));
    // Stopping a long-running agent by brushing a key is unrecoverable, so the
    // kill needs a second, differently-shaped keystroke.
    const [pendingKill, setPendingKill] = useState<string | null>(null);
    const pendingTask = pendingKill === null ? undefined : tasks.find((t) => t.id === pendingKill);

    useInput((input, key) => {
        if (!focused) return;
        if (pendingKill !== null) {
            if (input === "y" || input === "Y") onKill(pendingKill);
            setPendingKill(null);
            return;
        }
        if (key.upArrow) {
            if (selectedIndex === 0) {
                onFocusBack();
                return;
            }
            onSelectTab(tabs[selectedIndex - 1]!);
            return;
        }
        if (key.downArrow) {
            if (selectedIndex < tabs.length - 1) {
                onSelectTab(tabs[selectedIndex + 1]!);
            }
            return;
        }
        if (key.return) {
            onEnter(selectedTab);
            return;
        }
        if (key.escape) {
            onSelectTab("main");
            onFocusBack();
            return;
        }
        if (input === "k" && !key.ctrl && !key.meta) {
            const task = tasks.find((t) => t.id === selectedTab);
            if (task && task.status === "running") setPendingKill(task.id);
            return;
        }
    });

    return (
        <Box flexDirection="column">
            <Box flexDirection="row">
                {focused && <Text dimColor>↑↓ nav · enter open · k stop · esc input{"  "}</Text>}
                {tabs.map((tab) => {
                    const selected = tab === selectedTab;
                    const marker = selected ? "(•)" : "( )";
                    if (tab === "main") {
                        return (
                            <Box key="main">
                                <Text dimColor={!selected}>{marker} main</Text>
                                <Text dimColor>{"  "}</Text>
                            </Box>
                        );
                    }
                    const task = tasks.find((t) => t.id === tab);
                    if (!task) return null;
                    const color = statusColor(task.status);
                    const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
                    const elapsedStr =
                        elapsed < 60
                            ? `${elapsed}s`
                            : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;
                    const queued = task.mailbox.queued().length;
                    return (
                        <Box key={tab}>
                            <Text dimColor={!selected}>{marker} </Text>
                            <Text color={color}>
                                {kindLabel(task.kind)} {elapsedStr}
                            </Text>
                            {queued > 0 && <Text color="cyan"> +{queued}</Text>}
                            <Text dimColor>{"  "}</Text>
                        </Box>
                    );
                })}
            </Box>
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
