import { Box, Text } from "ink";
import type { TodoItem } from "../tools/index.ts";

interface TodoPanelProps {
    readonly todos: readonly TodoItem[];
}

// The panel renders the model's raw TodoWrite arguments, which reach it before
// the tool validates them, so an unrecognised status must not throw here.
const glyph = (status: string): { ch: string; color: string } => {
    switch (status) {
        case "completed":
            return { ch: "✓", color: "green" };
        case "in_progress":
            return { ch: "•", color: "yellow" };
        default:
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
            {todos.map((t, i) => {
                const { ch, color } = glyph(t.status);
                return (
                    <Box key={i}>
                        <Text color={color}>{ch} </Text>
                        <Text dimColor={t.status === "completed"}>{t.content}</Text>
                    </Box>
                );
            })}
        </Box>
    );
};
