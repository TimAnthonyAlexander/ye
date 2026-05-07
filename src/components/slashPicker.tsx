import { Box, Text } from "ink";
import { matchCommands } from "../commands/index.ts";

interface SlashPickerProps {
  readonly input: string;
}

const MAX_VISIBLE = 5;

export const SlashPicker = ({ input }: SlashPickerProps) => {
  const matches = matchCommands(input);
  if (matches.length === 0) return null;

  const visible = matches.slice(0, MAX_VISIBLE);
  const hiddenCount = matches.length - visible.length;

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {visible.map((cmd) => (
        <Box key={cmd.name}>
          <Text color="cyan">/{cmd.name}</Text>
          <Text dimColor> · {cmd.description}</Text>
        </Box>
      ))}
      {hiddenCount > 0 && <Text dimColor>…and {hiddenCount} more</Text>}
      {matches.length === 1 && <Text dimColor>Tab to complete</Text>}
    </Box>
  );
};
