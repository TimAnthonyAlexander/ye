import { Box, Text } from "ink";
import type { TodoItem } from "../tools/index.ts";

interface TodoPanelProps {
    readonly todos: readonly TodoItem[];
}

const glyph = (status: TodoItem["status"]): { ch: string; color: string } => {
    switch (status) {
        case "completed":
            return { ch: "✓", color: "green" };
        case "in_progress":
            return { ch: "•", color: "yellow" };
        case "pending":
            return { ch: "·", color: "gray" };
    }
};

export const TodoPanel = ({ todos }: TodoPanelProps) => {
    if (todos.length === 0) return null;
    return (
        <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
            marginBottom={1}
        >
            <Text bold dimColor>
                todos
            </Text>
            {todos.map((t) => {
                const { ch, color } = glyph(t.status);
                return (
                    <Box key={t.id}>
                        <Text color={color}>{ch} </Text>
                        <Text dimColor={t.status === "completed"}>{t.content}</Text>
                    </Box>
                );
            })}
        </Box>
    );
};
