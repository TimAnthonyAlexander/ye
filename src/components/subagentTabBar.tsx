import { Box, Text, useInput } from "ink";
import type { BackgroundSubagentTask } from "../subagents/background.ts";

interface SubagentTabBarProps {
    readonly tasks: readonly BackgroundSubagentTask[];
    readonly selectedTab: string; // "main" or task id
    readonly onSelectTab: (tab: string) => void;
    readonly onEnter: (tab: string) => void;
    readonly focused: boolean;
    readonly onFocusBack: () => void;
    readonly alwaysFocused: boolean; // When inside a subagent, always capture keys.
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
    focused,
    onFocusBack,
    alwaysFocused,
}: SubagentTabBarProps) => {
    const tabs = ["main", ...tasks.map((t) => t.id)];
    const selectedIndex = Math.max(0, tabs.indexOf(selectedTab));

    useInput((_input, key) => {
        if (!focused && !alwaysFocused) return;
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
            onEnter("main");
            return;
        }
    });

    return (
        <Box paddingX={1} flexDirection="row">
            {focused && <Text dimColor>↑↓ nav · enter select · esc main{"  "}</Text>}
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
                    elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;
                return (
                    <Box key={tab}>
                        <Text dimColor={!selected}>{marker} </Text>
                        <Text color={color}>
                            {kindLabel(task.kind)} {elapsedStr}
                        </Text>
                        <Text dimColor>{"  "}</Text>
                    </Box>
                );
            })}
        </Box>
    );
};
