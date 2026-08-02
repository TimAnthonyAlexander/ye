import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same sequence cli.tsx pushes at startup (see patch-stdin.ts). Editors that
// reset the terminal drop our kitty keyboard flags, so we re-push on return.
export const KITTY_KEYBOARD_ENABLE = "\x1b[>1u";

export const resolveEditorCommand = (env: NodeJS.ProcessEnv = process.env): string => {
    const visual = env["VISUAL"]?.trim();
    if (visual !== undefined && visual.length > 0) return visual;
    const editor = env["EDITOR"]?.trim();
    if (editor !== undefined && editor.length > 0) return editor;
    return process.platform === "win32" ? "notepad" : "vi";
};

export const normalizeEditorContent = (raw: string): string =>
    raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");

// Runs `command` on a temp copy of `initial` and returns what was saved, or
// null when the edit should be discarded (editor failed, exited non-zero, or
// could not be launched) so a broken editor never clobbers the draft.
export const editInEditor = (
    initial: string,
    command: string = resolveEditorCommand(),
): string | null => {
    const parts = command.split(/\s+/).filter((p) => p.length > 0);
    const bin = parts[0];
    if (bin === undefined) return null;

    const dir = mkdtempSync(join(tmpdir(), "ye-compose-"));
    const file = join(dir, "buffer.md");
    try {
        writeFileSync(file, initial, "utf8");
        let exitCode: number;
        try {
            exitCode = Bun.spawnSync({
                cmd: [bin, ...parts.slice(1), file],
                stdio: ["inherit", "inherit", "inherit"],
            }).exitCode;
        } catch {
            return null;
        }
        if (exitCode !== 0) return null;
        return normalizeEditorContent(readFileSync(file, "utf8"));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};
