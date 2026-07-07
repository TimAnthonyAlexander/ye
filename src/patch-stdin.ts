// Transform Kitty keyboard protocol (CSI u) and xterm modifyOtherKeys
// escape sequences into legacy sequences that Ink's parseKeypress natively
// understands. This gives us unambiguous Ctrl+Backspace, Ctrl+Arrow, and
// Option+Arrow events.
//
// Ink's App component reads stdin via the 'readable' event + read(), so we
// intercept process.stdin.read() and rewrite sequences before Ink sees them.
//
// Must be imported BEFORE any Ink module. Import at the very top of cli.tsx.

// CSI u (kitty keyboard protocol): ESC [ codepoint [; modifier] u
const CSI_U_RE = /^\x1b\[(\d+)(?:;(\d+))?u$/;
// xterm modifyOtherKeys: ESC [ 27 ; modifier ; keycode ~
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~$/;

const decodeMod = (m: number) => {
    const v = m - 1;
    return { shift: !!(v & 1), meta: !!(v & 2), ctrl: !!(v & 4) };
};

// Kitty functional key codepoints → legacy escape sequences.
// From https://sw.kovidgoyal.net/kitty/keyboard-protocol/#functional-key-definitions
const KITTY_MAP: Record<number, string> = {
    127: "\x7f", // Backspace → DEL
    9: "\t", // Tab
    13: "\r", // Return
    27: "\x1b", // Escape
    32: " ", // Space
    57376: "\x1b[3~", // Delete
    57377: "\x1b[2~", // Insert
    57378: "\x1b[A", // Up
    57379: "\x1b[B", // Down
    57380: "\x1b[D", // Left
    57381: "\x1b[C", // Right
    57382: "\x1b[H", // Home
    57383: "\x1b[F", // End
    57384: "\x1b[5~", // PageUp
    57385: "\x1b[6~", // PageDown
};

const transform = (s: string): string | null => {
    let match: RegExpExecArray | null;

    if ((match = CSI_U_RE.exec(s))) {
        const code = parseInt(match[1]!, 10);
        const mod = match[2] ? parseInt(match[2], 10) : 1;
        return rewriteCsiU(code, mod);
    }

    if ((match = MODIFY_OTHER_KEYS_RE.exec(s))) {
        const mod = parseInt(match[1]!, 10);
        const keycode = parseInt(match[2]!, 10);
        return rewriteModifyOtherKeys(keycode, mod);
    }

    return null;
};

const rewriteCsiU = (codepoint: number, modifier: number): string | null => {
    const m = decodeMod(modifier);

    // Backspace — the critical one: Ctrl+Backspace vs plain Backspace.
    if (codepoint === 127) {
        if (m.ctrl) return "\x17"; // Ctrl+W (readline kill-word)
        if (m.meta) return "\x1b\x7f"; // ESC DEL (Option+Backspace)
        return "\x7f"; // Plain Backspace → DEL
    }

    // Printable ASCII with modifiers.
    if (codepoint >= 32 && codepoint <= 126) {
        const ch = String.fromCodePoint(codepoint);
        if (m.ctrl && !m.meta) return String.fromCodePoint(codepoint - (m.shift ? 64 : 96));
        if (m.meta && !m.ctrl) return `\x1b${ch}`;
        return ch;
    }

    // Functional keys — encode as traditional ESC [ 1 ; modifier LETTER.
    const legacy = KITTY_MAP[codepoint];
    if (!legacy) return null;

    const kMod = 1 + (m.shift ? 1 : 0) + (m.meta ? 2 : 0) + (m.ctrl ? 4 : 0);
    if (kMod === 1) return legacy;

    // Arrows (legacy ends in a single letter like A/B/C/D)
    if (/^[A-Za-z]$/.test(legacy.slice(-1))) {
        return `\x1b[1;${kMod}${legacy.slice(-1)}`;
    }

    // ~-terminated (Home=H, End=F, PgUp/PgDn/Ins/Del)
    if (legacy.endsWith("~")) {
        const num = legacy.slice(2, -1); // e.g., "3" from "\x1b[3~"
        return `\x1b[${num};${kMod}~`;
    }

    // H/F home/end
    if (legacy.slice(-1) === "H" || legacy.slice(-1) === "F") {
        if (legacy.startsWith("\x1b[")) {
            const num = legacy.slice(2, -1) || "1";
            return `\x1b[${num};${kMod}${legacy.slice(-1)}`;
        }
    }

    return legacy;
};

const rewriteModifyOtherKeys = (keycode: number, modifier: number): string | null => {
    const m = decodeMod(modifier);

    if (keycode === 127) {
        if (m.ctrl) return "\x17"; // Ctrl+W
        if (m.meta) return "\x1b\x7f"; // ESC DEL
        return "\x7f";
    }

    if (keycode === 9) return "\t";
    if (keycode === 13) return "\r";
    if (keycode === 27) return "\x1b";
    if (keycode === 32) return " ";

    if (keycode >= 32 && keycode <= 126) {
        const ch = String.fromCodePoint(keycode);
        if (m.ctrl && !m.meta) return String.fromCodePoint(keycode - (m.shift ? 64 : 96));
        if (m.meta && !m.ctrl) return `\x1b${ch}`;
        return ch;
    }

    return null;
};

// Intercept process.stdin.read() to accumulate and transform Kitty/modifyOtherKeys
// sequences. Escape sequences can arrive split across multiple read() calls — a
// lone \x1b in one read, then [127;5u in the next. We buffer until a complete
// sequence is formed or until the data is clearly not a CSI u / modifyOtherKeys.
const originalRead = process.stdin.read.bind(process.stdin);

// Partial-sequence patterns. A partial CSI u starts with \x1b[ followed by
// digits and optionally a semicolon, but no terminating 'u'.
const PARTIAL_CSI_U = /^\x1b\[(?:\d+)?(?:;\d*)?$/;
// A partial modifyOtherKeys: \x1b[27 ; digits? ; digits?
const PARTIAL_MODIFY = /^\x1b\[27(?:;\d*)?(?:;\d*)?$/;

let buf = "";

process.stdin.read = function (size?: number) {
    const chunk = originalRead(size);
    if (chunk !== null) {
        buf += typeof chunk === "string" ? chunk : chunk.toString();
    }

    if (buf.length === 0) return chunk;

    // Check for a complete CSI u or modifyOtherKeys sequence.
    const transformed = transform(buf);
    if (transformed !== null) {
        buf = "";
        return Buffer.from(transformed);
    }

    // If new data arrived and the buffer looks like the start of a
    // CSI u or modifyOtherKeys sequence, wait for the next read.
    if (
        chunk !== null &&
        (PARTIAL_CSI_U.test(buf) || PARTIAL_MODIFY.test(buf) || buf === "\x1b")
    ) {
        return null;
    }

    // Stream drained or buffer doesn't match a known partial — flush.
    const out = Buffer.from(buf);
    buf = "";
    return out;
} as typeof process.stdin.read;

// Push Kitty keyboard protocol to the terminal so we get unambiguous
// key+modifier sequences. Most modern terminals support this: Kitty,
// iTerm2 3.5+, WezTerm, Ghostty, foot; Terminal.app ignores it.
process.stdout.write("\x1b[>1u");
