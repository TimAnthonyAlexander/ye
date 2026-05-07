import { Box, Text } from "ink";
import { MessageView } from "./message.tsx";
import { Thinking } from "./thinking.tsx";
import { ToolCallView, type ToolCallEntry } from "./toolCall.tsx";

export type ChatItem =
  | { readonly kind: "message"; readonly role: "user" | "assistant"; readonly content: string }
  | { readonly kind: "toolCall"; readonly entry: ToolCallEntry };

interface ChatProps {
  readonly items: readonly ChatItem[];
  readonly streamingText: string;
  readonly streaming: boolean;
}

let nextKey = 0;
const itemKey = (item: ChatItem, i: number): string => {
  if (item.kind === "toolCall") return `t-${item.entry.id}`;
  return `m-${i}-${nextKey++}`;
};

export const Chat = ({ items, streamingText, streaming }: ChatProps) => {
  return (
    <Box flexDirection="column" paddingX={1}>
      {items.map((item, i) => {
        const key = itemKey(item, i);
        if (item.kind === "message") {
          return (
            <MessageView key={key} message={{ role: item.role, content: item.content }} />
          );
        }
        return <ToolCallView key={key} entry={item.entry} />;
      })}
      {streaming &&
        (streamingText.length > 0 ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color="green">
              ye
            </Text>
            <Text>{streamingText}</Text>
          </Box>
        ) : (
          <Thinking />
        ))}
    </Box>
  );
};
