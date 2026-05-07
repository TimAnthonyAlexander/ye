import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import { ELAPSED_INTERVAL_MS, FRAME_INTERVAL_MS, FRAMES } from "./spinner.ts";

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
    const verb = useMemo(pickVerb, []);

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
            <Text color="magenta">{FRAMES[frame]}</Text>
            <Text> {verb}… </Text>
            <Text dimColor>({elapsedSec}s · thinking)</Text>
        </Box>
    );
};
