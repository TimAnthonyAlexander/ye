import { Box, Text } from "ink";
import type { LoadResult } from "../config/index.ts";

interface AppProps {
  readonly config: LoadResult;
}

export const App = ({ config }: AppProps) => {
  return (
    <Box flexDirection="column">
      <Text>Hello</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {config.created ? "created" : "loaded"} {config.path}
        </Text>
        <Text dimColor>
          model: {config.config.defaultModel.provider}:{config.config.defaultModel.model}
        </Text>
      </Box>
    </Box>
  );
};
