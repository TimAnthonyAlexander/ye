import { Box, Text } from "ink";
import type { Message } from "../providers/index.ts";

interface MessageViewProps {
    readonly message: Message;
}

const labelFor = (role: Message["role"]): { label: string; color: string } => {
    switch (role) {
        case "user":
            return { label: "you", color: "cyan" };
        case "assistant":
            return { label: "ye", color: "green" };
        case "system":
            return { label: "system", color: "gray" };
        case "tool":
            return { label: "tool", color: "yellow" };
    }
};

export const MessageView = ({ message }: MessageViewProps) => {
    if (message.role === "tool" || message.role === "system") return null;
    const { label, color } = labelFor(message.role);
    const content = message.content ?? "";

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Text bold color={color}>
                {label}
            </Text>
            <Text>{content}</Text>
        </Box>
    );
};
