import { Box, Text, useInput } from "ink";
import type { BackgroundSubagentTask } from "../subagents/background.ts";

interface SubagentInspectorProps {
    readonly tasks: readonly BackgroundSubagentTask[];
    readonly selectedTab: string; // "main" or task id
    readonly onSelectTab: (tab: string) => void;
    readonly onClose: () => void;
}

const kindLabel = (kind: string): string => {
    switch (kind) {
        case "explore":
            return "Explore";
        case "general":
            return "General";
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

const RADIO_ON = "(•)";
const RADIO_OFF = "( )";

export const SubagentInspector = ({
    tasks,
    selectedTab,
    onSelectTab,
    onClose,
}: SubagentInspectorProps) => {
    const tabs = ["main", ...tasks.map((t) => t.id)];
    const selectedIndex = Math.max(0, tabs.indexOf(selectedTab));

    useInput((_input, key) => {
        if (key.upArrow || key.downArrow) {
            const delta = key.upArrow ? -1 : 1;
            const next = Math.max(0, Math.min(tabs.length - 1, selectedIndex + delta));
            onSelectTab(tabs[next]!);
            return;
        }
        if (key.return || key.escape) {
            onClose();
            return;
        }
    });

    const selectedTask = selectedTab === "main" ? null : tasks.find((t) => t.id === selectedTab);

    return (
        <Box flexDirection="column" paddingX={1}>
            <Box marginBottom={1}>
                <Text bold dimColor>
                    subagent inspector · ↑↓ navigate · enter/esc close
                </Text>
            </Box>

            <Box flexDirection="column" marginBottom={1}>
                {tabs.map((tab) => {
                    const selected = tab === selectedTab;
                    if (tab === "main") {
                        return (
                            <Box key="main">
                                <Text>{selected ? RADIO_ON : RADIO_OFF}</Text>
                                <Text> main</Text>
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
                    return (
                        <Box key={tab}>
                            <Text>{selected ? RADIO_ON : RADIO_OFF}</Text>
                            <Text> </Text>
                            <Text color={color}>
                                {kindLabel(task.kind)} ({task.status})
                            </Text>
                            <Text dimColor> {elapsedStr}</Text>
                        </Box>
                    );
                })}
            </Box>

            {selectedTask ? (
                <Box flexDirection="column">
                    <Box marginBottom={1}>
                        <Text dimColor>prompt: </Text>
                        <Text>{selectedTask.prompt}</Text>
                    </Box>
                    <Box flexDirection="column">
                        {selectedTask.liveLog.length === 0 && (
                            <Text dimColor>(no tool activity yet)</Text>
                        )}
                        {selectedTask.liveLog.map((line, i) => (
                            <Text key={`log-${i}`} dimColor>
                                {line}
                            </Text>
                        ))}
                    </Box>
                </Box>
            ) : (
                <Text dimColor>select a subagent to see its live activity</Text>
            )}
        </Box>
    );
};
