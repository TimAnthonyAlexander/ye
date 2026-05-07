import { Box, Static, Text } from "ink";
import { memo } from "react";
import { AssistantLine, MessageView } from "./message.tsx";
import { Thinking } from "./thinking.tsx";
import { ToolCallView, type ToolCallEntry } from "./toolCall.tsx";

export type ChatItem =
    | {
          readonly kind: "message";
          readonly id: string;
          readonly role: "user" | "assistant";
          readonly content: string;
      }
    | { readonly kind: "system"; readonly id: string; readonly content: string }
    | { readonly kind: "toolCall"; readonly entry: ToolCallEntry };

interface ChatProps {
    readonly items: readonly ChatItem[];
    readonly streamingText: string;
    readonly streaming: boolean;
}

// Sequence-based IDs for messages/system items. Module-level is fine because
// these are minted at creation time (in setItems handlers), never during a
// render — the previous bug was a counter that bumped every itemKey() call.
let idSeq = 0;
export const newChatItemId = (): string => `c${++idSeq}`;

const itemKey = (item: ChatItem): string =>
    item.kind === "toolCall" ? `t-${item.entry.id}` : `c-${item.id}`;

interface RenderItemProps {
    readonly item: ChatItem;
}

// Memoized: re-renders only when the item reference changes. Tool calls get
// new entry references on status updates (entry: {...prev, status}), which
// is what we want; messages and system items never mutate after creation.
const RenderItem = memo(({ item }: RenderItemProps) => {
    if (item.kind === "message") {
        return <MessageView message={{ role: item.role, content: item.content }} />;
    }
    if (item.kind === "system") {
        return (
            <Box marginBottom={1}>
                <Text dimColor>{item.content}</Text>
            </Box>
        );
    }
    return <ToolCallView entry={item.entry} />;
});
RenderItem.displayName = "RenderItem";

export const Chat = ({ items, streamingText, streaming }: ChatProps) => {
    // Items up to (but not including) the first still-running tool call are
    // committed — Ink's <Static> renders them once into scrollback and never
    // touches them again. Everything from the first running tool onward stays
    // dynamic so its status updates can repaint. Order is preserved even if
    // tool calls finish out of order: a later-finished tool waits for any
    // earlier still-running tool before it can commit.
    const firstRunning = items.findIndex(
        (item) => item.kind === "toolCall" && item.entry.status === "running",
    );
    const splitAt = firstRunning === -1 ? items.length : firstRunning;
    const committed = splitAt === items.length ? items : items.slice(0, splitAt);
    const inFlight = splitAt === items.length ? [] : items.slice(splitAt);

    // While a tool is mid-execution, its own running indicator (and progress
    // panel for Task) signals liveness — the generic Thinking spinner becomes
    // misleading and visually competes with the tool entry.
    const hasRunningTool = inFlight.some(
        (item) => item.kind === "toolCall" && item.entry.status === "running",
    );

    return (
        <>
            <Static items={committed as ChatItem[]}>
                {(item) => (
                    <Box key={itemKey(item)} paddingX={1}>
                        <RenderItem item={item} />
                    </Box>
                )}
            </Static>
            <Box flexDirection="column" paddingX={1}>
                {inFlight.map((item) => (
                    <RenderItem key={itemKey(item)} item={item} />
                ))}
                {streaming &&
                    !hasRunningTool &&
                    (streamingText.length > 0 ? (
                        <AssistantLine content={streamingText} />
                    ) : (
                        <Thinking />
                    ))}
            </Box>
        </>
    );
};
