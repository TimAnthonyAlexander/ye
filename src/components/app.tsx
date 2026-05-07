import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { LoadResult, PermissionMode } from "../config/index.ts";
import type { Message } from "../providers/index.ts";
import { getProvider, MissingApiKeyError } from "../providers/index.ts";
import { cycleMode } from "../ui/keybinds.ts";
import { Chat } from "./chat.tsx";
import { ChatInput } from "./input.tsx";
import { StatusBar } from "./statusBar.tsx";

interface AppProps {
  readonly config: LoadResult;
}

export const App = ({ config }: AppProps) => {
  const cfg = config.config;
  const [mode, setMode] = useState<PermissionMode>(
    cfg.permissions?.defaultMode ?? "NORMAL",
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useInput((_, key) => {
    if (key.tab && key.shift) {
      setMode(cycleMode);
    }
  });

  const send = async (text: string): Promise<void> => {
    setError(null);
    const userMsg: Message = { role: "user", content: text };
    const next: Message[] = [...messages, userMsg];
    setMessages(next);
    setStreaming(true);
    setStreamingText("");

    let acc = "";
    let stopError: string | null = null;

    try {
      const provider = getProvider(cfg);
      const stream = provider.stream({
        model: cfg.defaultModel.model,
        messages: next,
        providerOptions: {
          providerOrder: cfg.defaultModel.providerOrder,
          allowFallbacks: cfg.defaultModel.allowFallbacks,
        },
      });

      for await (const evt of stream) {
        if (evt.type === "text.delta") {
          acc += evt.text;
          setStreamingText(acc);
        } else if (evt.type === "stop") {
          if (evt.error) stopError = evt.error;
          break;
        }
      }
    } catch (e) {
      if (e instanceof MissingApiKeyError) {
        stopError = e.message;
      } else {
        stopError = e instanceof Error ? e.message : String(e);
      }
    }

    if (acc.length > 0) {
      setMessages([...next, { role: "assistant", content: acc }]);
    }
    if (stopError) {
      setError(stopError);
    }
    setStreaming(false);
    setStreamingText("");
  };

  return (
    <Box flexDirection="column">
      <Chat messages={messages} streamingText={streamingText} streaming={streaming} />
      {error !== null && (
        <Box paddingX={1} marginBottom={1}>
          <Text color="red">error: {error}</Text>
        </Box>
      )}
      <ChatInput onSubmit={send} disabled={streaming} />
      <StatusBar mode={mode} model={cfg.defaultModel.model} streaming={streaming} />
    </Box>
  );
};
