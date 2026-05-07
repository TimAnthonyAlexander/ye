import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

interface ClipboardTool {
    readonly cmd: readonly string[];
    readonly label: string;
}

const clipboardTool = (): ClipboardTool | null => {
    switch (process.platform) {
        case "darwin":
            return { cmd: ["pbcopy"], label: "pbcopy" };
        case "win32":
            return { cmd: ["clip"], label: "clip" };
        case "linux":
            // wl-copy for Wayland sessions, xclip as the X11 fallback. We can't
            // probe both from a slash command, so prefer wl-copy when WAYLAND_DISPLAY
            // is set; otherwise use xclip.
            return process.env.WAYLAND_DISPLAY
                ? { cmd: ["wl-copy"], label: "wl-copy" }
                : { cmd: ["xclip", "-selection", "clipboard"], label: "xclip" };
        default:
            return null;
    }
};

const writeClipboard = async (text: string, tool: ClipboardTool): Promise<void> => {
    const proc = Bun.spawn(tool.cmd as string[], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
    });
    proc.stdin.write(text);
    await proc.stdin.end();
    const code = await proc.exited;
    if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(stderr.trim() || `${tool.label} exited with code ${code}`);
    }
};

export const CopyCommand: SlashCommand = {
    name: "copy",
    description: "Copy the last assistant message to the system clipboard.",
    execute: async (_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const text = ctx.getLastAssistantText();
        if (text === null || text.length === 0) {
            return { kind: "error", message: "Nothing to copy — no assistant message yet." };
        }
        const tool = clipboardTool();
        if (!tool) {
            return {
                kind: "error",
                message: `Clipboard not supported on platform ${process.platform}.`,
            };
        }
        try {
            await writeClipboard(text, tool);
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            return { kind: "error", message: `Copy failed (${tool.label}): ${detail}` };
        }
        const charCount = text.length;
        ctx.addSystemMessage(
            `Copied last assistant message to clipboard (${charCount} character${
                charCount === 1 ? "" : "s"
            }).`,
        );
        return { kind: "ok" };
    },
};
