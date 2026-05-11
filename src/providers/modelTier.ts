// Heuristic for detecting "small" model variants (mini, nano) regardless of
// vendor. Word-boundary segment match — splits on any non-alphanumeric
// character and checks if any resulting segment equals one of the trigger
// tokens. Avoids the obvious false positives — "gemini" contains "mini" as a
// substring but its only segment is "gemini", so it does NOT match. Matches
// "gpt-5.1-codex-mini", "gpt-5.4-nano", "phi-3-mini", "haiku-mini", etc.

const SMALL_MODEL_SEGMENT_TRIGGERS = new Set(["mini", "nano"]);

export const isSmallModel = (model: string): boolean => {
    const segments = model.toLowerCase().split(/[^a-z0-9]+/);
    return segments.some((seg) => SMALL_MODEL_SEGMENT_TRIGGERS.has(seg));
};
