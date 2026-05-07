import { Box, Text } from "ink";
import { useEffect, useState } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_INTERVAL_MS = 80;
const ELAPSED_INTERVAL_MS = 250;

export const Thinking = () => {
  const [frame, setFrame] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const frameId = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, FRAME_INTERVAL_MS);
    const elapsedId = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, ELAPSED_INTERVAL_MS);
    return () => {
      clearInterval(frameId);
      clearInterval(elapsedId);
    };
  }, []);

  return (
    <Box marginBottom={1}>
      <Text color="cyan">{FRAMES[frame]}</Text>
      <Text dimColor> Thinking… ({elapsedSec}s)</Text>
    </Box>
  );
};
