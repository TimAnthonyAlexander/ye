import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editInEditor, normalizeEditorContent, resolveEditorCommand } from "./editor.ts";

const scriptDir = mkdtempSync(join(tmpdir(), "ye-editor-test-"));

const makeScript = (name: string, body: string): string => {
    const path = join(scriptDir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
    chmodSync(path, 0o755);
    return path;
};

afterAll(() => {
    rmSync(scriptDir, { recursive: true, force: true });
});

describe("resolveEditorCommand", () => {
    test("prefers VISUAL", () => {
        expect(resolveEditorCommand({ VISUAL: "hx", EDITOR: "nano" })).toBe("hx");
    });

    test("falls back to EDITOR", () => {
        expect(resolveEditorCommand({ EDITOR: "nano" })).toBe("nano");
    });

    test("ignores empty and whitespace-only values", () => {
        expect(resolveEditorCommand({ VISUAL: "   ", EDITOR: "nano" })).toBe("nano");
    });

    test("falls back to a platform default", () => {
        const expected = process.platform === "win32" ? "notepad" : "vi";
        expect(resolveEditorCommand({})).toBe(expected);
    });
});

describe("normalizeEditorContent", () => {
    test("trims the trailing newline editors append", () => {
        expect(normalizeEditorContent("hello\n")).toBe("hello");
    });

    test("preserves interior newlines", () => {
        expect(normalizeEditorContent("a\nb\nc\n")).toBe("a\nb\nc");
    });

    test("normalizes CRLF", () => {
        expect(normalizeEditorContent("a\r\nb\r\n")).toBe("a\nb");
    });

    test("leaves content without a trailing newline alone", () => {
        expect(normalizeEditorContent("hello")).toBe("hello");
    });
});

describe("editInEditor", () => {
    test("round-trips the buffer through the editor", () => {
        const editor = makeScript("append.sh", 'printf " world\\n" >> "$1"');
        expect(editInEditor("hello", editor)).toBe("hello world");
    });

    test("passes the buffer to the editor and keeps multi-line edits", () => {
        const editor = makeScript("multiline.sh", 'printf "line2\\n" >> "$1"');
        expect(editInEditor("line1\n", editor)).toBe("line1\nline2");
    });

    test("uses a .md temp file so editors highlight it as markdown", () => {
        const editor = makeScript("echopath.sh", 'printf "%s" "$1" > "$1"');
        expect(editInEditor("ignored", editor)).toMatch(/\.md$/);
    });

    test("discards the edit when the editor exits non-zero", () => {
        const editor = makeScript("fail.sh", 'printf "clobbered" >> "$1"\nexit 1');
        expect(editInEditor("keep me", editor)).toBeNull();
    });

    test("discards the edit when the editor cannot be launched", () => {
        expect(editInEditor("keep me", "ye-no-such-editor-xyz")).toBeNull();
    });

    test("discards the edit for an empty command", () => {
        expect(editInEditor("keep me", "   ")).toBeNull();
    });

    test("passes extra editor arguments through", () => {
        const editor = makeScript("args.sh", 'printf "%s" "$1" > "$2"');
        expect(editInEditor("", `${editor} --wait`)).toBe("--wait");
    });
});
