const INIT_TIP = "Run /init to scaffold a YE.md so Ye learns your project conventions.";

const TIPS: readonly string[] = [
    "Press @ to mention a file from the project tree.",
    "Shift+Tab cycles permission mode (NORMAL → AUTO → PLAN).",
    "/resume reopens any prior session by title or preview.",
    "/rewind drops the conversation back to a chosen prompt.",
    "Ctrl+O toggles tool-call group expansion.",
    "Ctrl+C clears your input; press it again to abort a streaming reply.",
    "/mode AUTO runs tools without per-call permission prompts.",
    "Type a slash to discover commands — / opens the picker.",
    "/clear starts a fresh session and clears the screen.",
    "/help lists every keybinding and slash command.",
];

export const pickTip = (projectInitialized: boolean): string => {
    if (!projectInitialized) return INIT_TIP;
    const idx = Math.floor(Math.random() * TIPS.length);
    return TIPS[idx] ?? TIPS[0]!;
};
