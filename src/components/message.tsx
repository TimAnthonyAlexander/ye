import { Box, Text, useStdout } from "ink";
import { memo } from "react";
import type { Message } from "../providers/index.ts";

interface MessageViewProps {
    readonly message: Message;
}

interface BubbleLine {
    readonly isFirst: boolean;
    readonly text: string;
}

// Word-wrap content for the user bubble. The first line is shortened by 2
// columns to leave room for the "> " prefix; subsequent lines fill `inner`.
const wrapForBubble = (content: string, inner: number): readonly BubbleLine[] => {
    const firstCap = Math.max(1, inner - 2);
    const out: BubbleLine[] = [];
    let isFirst = true;
    for (const para of content.split("\n")) {
        let s = para;
        while (true) {
            const cap = isFirst ? firstCap : inner;
            if (s.length <= cap) {
                out.push({ isFirst, text: s });
                isFirst = false;
                break;
            }
            let bp = s.lastIndexOf(" ", cap);
            if (bp <= 0) bp = cap;
            out.push({ isFirst, text: s.slice(0, bp) });
            s = s.slice(bp).replace(/^ /, "");
            isFirst = false;
        }
    }
    if (out.length === 0) out.push({ isFirst: true, text: "" });
    return out;
};

const UserBubble = ({ content }: { content: string }) => {
    const { stdout } = useStdout();
    const cols = stdout?.columns ?? 80;
    // Outer chat paddingX=1 on each side + bubble paddingX=1 on each side = 4 cols.
    const inner = Math.max(1, cols - 4);
    const firstCap = Math.max(1, inner - 2);
    const lines = wrapForBubble(content, inner);

    return (
        <Box marginBottom={1} flexDirection="column" paddingX={1} width="100%">
            {lines.map((line, i) => (
                <Text key={i} backgroundColor="#3a3a3a">
                    {line.isFirst ? <Text color="gray">{"> "}</Text> : null}
                    {line.text.padEnd(line.isFirst ? firstCap : inner, " ")}
                </Text>
            ))}
        </Box>
    );
};

// Shared by committed assistant messages AND the in-progress streaming view
// in chat.tsx — keep a single source of truth so the two paths can't drift.
export const AssistantLine = ({ content }: { content: string }) => (
    <Box marginBottom={1}>
        <Text color="green">{"● "}</Text>
        <Text>{content}</Text>
    </Box>
);

export const MessageView = memo(({ message }: MessageViewProps) => {
    if (message.role === "tool" || message.role === "system") return null;
    const content = message.content ?? "";

    if (message.role === "user") {
        return <UserBubble content={content} />;
    }

    return <AssistantLine content={content} />;
});
MessageView.displayName = "MessageView";
