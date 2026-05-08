import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import { ELAPSED_INTERVAL_MS, FRAME_INTERVAL_MS, FRAMES } from "./spinner.ts";

const WAVE_INTERVAL_MS = 110;

interface CharStyle {
    readonly color: string;
    readonly dim: boolean;
    readonly bold: boolean;
}

const styleForDistance = (d: number): CharStyle => {
    if (d === 0) return { color: "magentaBright", dim: false, bold: true };
    if (d === 1) return { color: "magenta", dim: false, bold: false };
    if (d <= 2) return { color: "magenta", dim: true, bold: false };
    return { color: "magenta", dim: true, bold: false };
};

const VERBS = [
    "Thinking",
    "Pondering",
    "Cogitating",
    "Ruminating",
    "Contemplating",
    "Deliberating",
    "Mulling",
    "Reckoning",
    "Brainstorming",
    "Synthesizing",
    "Distilling",
    "Marinating",
    "Steeping",
    "Brewing",
    "Cooking",
    "Hatching",
    "Conjuring",
    "Divining",
    "Untangling",
    "Wrangling",
    "Noodling",
    "Percolating",
    "Simmering",
    "Sleuthing",
    "Spelunking",
    "Excavating",
    "Investigating",
    "Probing",
    "Musing",
    "Weaving",
    "Crafting",
    "Engineering",
    "Manifesting",
    "Concocting",
    "Plotting",
    "Scheming",
    "Caffeinating",
    "Vibing",
    "Elucidating",
    "Excogitating",
    "Ratiocinating",
    "Confabulating",
    "Galaxy-braining",
    "Hyperfocusing",
    "Yak-shaving",
    "Bikeshedding",
] as const;

const pickVerb = (): string => VERBS[Math.floor(Math.random() * VERBS.length)] ?? "Thinking";

export const Thinking = () => {
    const [frame, setFrame] = useState(0);
    const [elapsedSec, setElapsedSec] = useState(0);
    const [tick, setTick] = useState(0);
    const verb = useMemo(pickVerb, []);
    const display = `${verb}…`;
    const len = display.length;
    // Ping-pong period: head walks 0 → len-1 then len-1 → 0 each cycle.
    const period = Math.max(1, 2 * (len - 1));
    const phase = tick % period;
    const head = phase <= len - 1 ? phase : period - phase;

    useEffect(() => {
        const startedAt = Date.now();
        const frameId = setInterval(() => {
            setFrame((f) => (f + 1) % FRAMES.length);
        }, FRAME_INTERVAL_MS);
        const elapsedId = setInterval(() => {
            setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
        }, ELAPSED_INTERVAL_MS);
        const waveId = setInterval(() => {
            setTick((t) => (t + 1) % 1_000_000);
        }, WAVE_INTERVAL_MS);
        return () => {
            clearInterval(frameId);
            clearInterval(elapsedId);
            clearInterval(waveId);
        };
    }, []);

    return (
        <Box marginBottom={1}>
            <Text color="magenta">{FRAMES[frame]}</Text>
            <Text> </Text>
            {[...display].map((ch, i) => {
                const style = styleForDistance(Math.abs(i - head));
                return (
                    <Text
                        // eslint-disable-next-line react/no-array-index-key
                        key={i}
                        color={style.color}
                        dimColor={style.dim}
                        bold={style.bold}
                    >
                        {ch}
                    </Text>
                );
            })}
            <Text> </Text>
            <Text dimColor>({elapsedSec}s · thinking)</Text>
        </Box>
    );
};
