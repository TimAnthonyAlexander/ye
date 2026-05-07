// Shared by Thinking (between-turn) and ToolCallView (mid-tool). One source of
// truth so the cadence and glyphs match — visual unity matters more than
// per-component flexibility.
export const FRAMES = ["✻", "✦", "✧", "✶", "✷", "✸"] as const;
export const FRAME_INTERVAL_MS = 120;
export const ELAPSED_INTERVAL_MS = 250;
