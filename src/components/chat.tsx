import { Box, Text } from "ink";
import type { Message } from "../providers/index.ts";
import { MessageView } from "./message.tsx";

interface ChatProps {
  readonly messages: readonly Message[];
  readonly streamingText: string;
  readonly streaming: boolean;
}

export const Chat = ({ messages, streamingText, streaming }: ChatProps) => {
  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.map((m, i) => (
        <MessageView key={i} message={m} />
      ))}
      {streaming && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">
            ye
          </Text>
          <Text>{streamingText.length > 0 ? streamingText : <Text dimColor>…</Text>}</Text>
        </Box>
      )}
    </Box>
  );
};
