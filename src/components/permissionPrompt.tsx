import { Box, Text, useInput } from "ink";
import type { PermissionPromptPayload, PromptResponse } from "../permissions/index.ts";

interface PermissionPromptProps {
  readonly payload: PermissionPromptPayload;
  readonly onRespond: (decision: PromptResponse) => void;
}

const previewBash = (args: unknown): string => {
  const a = args as { command?: string };
  return a.command ? `$ ${a.command}` : "(unknown command)";
};
const previewEdit = (args: unknown): string => {
  const a = args as { path?: string; old_string?: string };
  const head = (a.old_string ?? "").replace(/\s+/g, " ").slice(0, 80);
  return `${a.path ?? "?"}\n  old: ${head}${(a.old_string ?? "").length > 80 ? "…" : ""}`;
};
const previewWrite = (args: unknown): string => {
  const a = args as { path?: string };
  return a.path ?? "?";
};
const previewSimple = (args: unknown): string => {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
};

const renderArgs = (name: string, args: unknown): string => {
  switch (name) {
    case "Bash":
      return previewBash(args);
    case "Edit":
      return previewEdit(args);
    case "Write":
      return previewWrite(args);
    default:
      return previewSimple(args);
  }
};

const truncate = (s: string, max = 200): string =>
  s.length > max ? `${s.slice(0, max)}…` : s;

export const PermissionPrompt = ({ payload, onRespond }: PermissionPromptProps) => {
  useInput((input, key) => {
    if (key.escape) return onRespond("deny");
    const ch = input.toLowerCase();
    if (ch === "y") return onRespond("allow_once");
    if (ch === "s" && payload.reason !== "exit_plan_mode") return onRespond("allow_session");
    if (ch === "n") return onRespond("deny");
  });

  if (payload.reason === "exit_plan_mode") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="magenta"
        paddingX={1}
        marginBottom={1}
      >
        <Text bold color="magenta">
          Plan submitted — switch out of PLAN mode?
        </Text>
        {payload.planPath && (
          <Text dimColor>saved to {payload.planPath}</Text>
        )}
        <Text>
          Switch to <Text bold>{payload.target ?? "NORMAL"}</Text> and proceed? <Text dimColor>(y / n)</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color="yellow">
        Allow {payload.toolCall.name}?
      </Text>
      <Text>{truncate(renderArgs(payload.toolCall.name, payload.toolCall.args))}</Text>
      <Text dimColor>y allow once · s allow for session · n deny</Text>
    </Box>
  );
};
