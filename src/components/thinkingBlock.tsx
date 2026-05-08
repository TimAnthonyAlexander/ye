import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { ELAPSED_INTERVAL_MS, FRAME_INTERVAL_MS, FRAMES } from "./spinner.ts";

const TAIL_LINES = 5;
const TAIL_WIDTH = 100;

const tailOf = (text: string): readonly string[] => {
    const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    const last = lines.slice(-TAIL_LINES);
    return last.map((l) => (l.length > TAIL_WIDTH ? `${l.slice(0, TAIL_WIDTH - 1)}…` : l));
};

const formatElapsed = (ms: number): string => {
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
};

interface LiveProps {
    readonly content: string;
    readonly startedAt: number;
}

export const ThinkingLive = ({ content, startedAt }: LiveProps) => {
    const [frame, setFrame] = useState(0);
    const [elapsedSec, setElapsedSec] = useState(() =>
        Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    );

    useEffect(() => {
        const f = setInterval(() => setFrame((x) => (x + 1) % FRAMES.length), FRAME_INTERVAL_MS);
        const e = setInterval(
            () => setElapsedSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))),
            ELAPSED_INTERVAL_MS,
        );
        return () => {
            clearInterval(f);
            clearInterval(e);
        };
    }, [startedAt]);

    const tail = tailOf(content);

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Box>
                <Text color="magenta">{FRAMES[frame]}</Text>
                <Text bold color="magenta">
                    {" "}
                    Thinking…
                </Text>
                <Text dimColor> ({elapsedSec}s)</Text>
            </Box>
            {tail.length > 0 && (
                <Box flexDirection="column" marginLeft={2}>
                    {tail.map((line, i) => (
                        <Text key={i} dimColor>
                            {line}
                        </Text>
                    ))}
                </Box>
            )}
        </Box>
    );
};

interface DoneProps {
    readonly elapsedMs: number;
}

export const ThinkingDone = ({ elapsedMs }: DoneProps) => (
    <Box marginBottom={1}>
        <Text dimColor>✻ Thought for {formatElapsed(elapsedMs)}</Text>
    </Box>
);
