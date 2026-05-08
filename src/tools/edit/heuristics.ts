// Cheap, deterministic, advisory checks run after a successful Edit. Output
// is folded into the tool result's `feedback` field so the LLM gets a soft
// signal about likely-mistakes without the edit being blocked. Each check
// must be O(file size) at worst — no parsing, no LSP. False positives erode
// trust faster than false negatives miss bugs, so prefer skipping over noisy
// firing.

const MAX_MESSAGES = 3;
const MAX_MESSAGE_CHARS = 200;
const DUP_BLOCK_MIN_LINES = 4;
const DUP_BLOCK_MIN_BYTES = 80;
const INDENT_FILE_SAMPLE_LINES = 200;
const INDENT_DOMINANCE_THRESHOLD = 0.9;
const INDENT_MIN_INDENTED_LINES = 10;

export interface EvaluateInput {
    readonly original: string;
    readonly updated: string;
    readonly old_string: string;
    readonly new_string: string;
    readonly replace_all: boolean;
}

const truncate = (s: string): string =>
    s.length <= MAX_MESSAGE_CHARS ? s : `${s.slice(0, MAX_MESSAGE_CHARS - 1)}…`;

const countOccurrences = (text: string, needle: string): number =>
    needle.length === 0 ? 0 : text.split(needle).length - 1;

const CONFLICT_LINE_RE = /^(?:<<<<<<<|=======|>>>>>>>)/m;
const checkConflictMarker = (newStr: string): string | null => {
    if (!CONFLICT_LINE_RE.test(newStr)) return null;
    return "conflict: new_string contains a git conflict marker (<<<<<<<, =======, or >>>>>>>) — likely an unresolved merge";
};

// Patterns that show up only when an LLM is producing a placeholder rather
// than real code. Each is anchored to a line-start (with optional leading
// whitespace) to avoid hits inside spread/destructuring (`{ ...rest }`) or
// JSX (`{...props}`) which legitimately use `...`.
const STUB_PATTERNS: readonly RegExp[] = [
    /^\s*\/\/\s*\.{3}\s*$/m,
    /^\s*\/\/\s*\.{3,}.*existing/im,
    /^\s*\/\/\s*existing\s+code/im,
    /^\s*\/\/\s*rest\s+(of|unchanged)/im,
    /^\s*\/\/\s*keep\s+existing/im,
    /^\s*\/\/\s*\(unchanged\)/im,
    /^\s*\/\/\s*truncated/im,
    /^\s*#\s*\.{3}/m,
    /^\s*#\s*existing\s+code/im,
    /^\s*#\s*rest\s+(of|unchanged)/im,
    /^\s*#\s*truncated/im,
    /^\s*\/\*\s*\.{3}\s*\*\/\s*$/m,
    /^\s*\/\*\s*existing\s+code\s*\*\//im,
    /^\s*<!--\s*existing/im,
    /^\s*<!--\s*\.{3}/m,
];
const checkStub = (newStr: string, oldStr: string): string | null => {
    if (!STUB_PATTERNS.some((re) => re.test(newStr))) return null;
    const oldLines = oldStr.split("\n").length;
    const newLines = newStr.split("\n").length;
    const lostMajority = oldLines >= 4 && newLines * 2 < oldLines;
    if (lostMajority) {
        return `stub: new_string contains an elision placeholder (e.g. "// ...") AND has <50% the lines of old_string — likely deleted code by accident`;
    }
    return 'stub: new_string contains an elision placeholder (e.g. "// ...", "// existing code") — likely an LLM stub, not real code';
};

const checkCrlf = (original: string, newStr: string): string | null => {
    if (!newStr.includes("\n") || !original.includes("\n")) return null;
    const newHasCrlf = newStr.includes("\r\n");
    const newHasLoneLf = /(?:^|[^\r])\n/.test(newStr);
    const origHasCrlf = original.includes("\r\n");
    const origHasLoneLf = /(?:^|[^\r])\n/.test(original);
    if (origHasCrlf && !origHasLoneLf && newHasLoneLf) {
        return "crlf: file uses CRLF line endings but new_string contains lone LF — endings will be inconsistent";
    }
    if (origHasLoneLf && !origHasCrlf && newHasCrlf) {
        return "crlf: file uses LF line endings but new_string contains CRLF — endings will be inconsistent";
    }
    return null;
};

const checkNoopWhitespace = (input: EvaluateInput): string | null => {
    if (input.replace_all) return null;
    if (input.old_string === input.new_string) return null;
    if (input.old_string.trim() !== input.new_string.trim()) return null;
    return "noop-ws: new_string differs from old_string only in whitespace — verify the change is intentional";
};

const isNontrivialLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (trimmed.length < 8) return false;
    return /[A-Za-z0-9_]/.test(trimmed);
};

const findRepeatedBlockWithin = (newStr: string): boolean => {
    const lines = newStr.split("\n");
    if (lines.length < DUP_BLOCK_MIN_LINES * 2) return false;
    for (let i = 0; i + DUP_BLOCK_MIN_LINES <= lines.length; i++) {
        const window = lines.slice(i, i + DUP_BLOCK_MIN_LINES);
        if (!window.every(isNontrivialLine)) continue;
        const blockBytes = window.join("\n").length;
        if (blockBytes < DUP_BLOCK_MIN_BYTES) continue;
        for (let j = i + DUP_BLOCK_MIN_LINES; j + DUP_BLOCK_MIN_LINES <= lines.length; j++) {
            let match = true;
            for (let k = 0; k < DUP_BLOCK_MIN_LINES; k++) {
                if (lines[i + k] !== lines[j + k]) {
                    match = false;
                    break;
                }
            }
            if (match) return true;
        }
    }
    return false;
};

const checkDupBlock = (input: EvaluateInput): string | null => {
    const { original, updated, new_string, replace_all } = input;
    if (findRepeatedBlockWithin(new_string)) {
        return "dup-block: new_string contains the same multi-line block twice — paste-twice mistake?";
    }
    if (replace_all) return null;
    const trimmedNew = new_string.replace(/\n+$/, "");
    if (trimmedNew.length < DUP_BLOCK_MIN_BYTES) return null;
    if (trimmedNew.split("\n").length < 3) return null;
    const occUpdated = countOccurrences(updated, trimmedNew);
    const occOriginal = countOccurrences(original, trimmedNew);
    if (occUpdated >= 2 && occUpdated > occOriginal) {
        return "dup-block: new_string is now duplicated elsewhere in the file — this edit increased the duplicate count";
    }
    return null;
};

const getLeadingWs = (line: string): string => {
    const match = line.match(/^[\t ]*/);
    return match ? match[0] : "";
};

const isPureTabs = (ws: string): boolean => ws.length > 0 && /^\t+$/.test(ws);
const isPureSpaces = (ws: string): boolean => ws.length > 0 && /^ +$/.test(ws);

const detectDominantIndent = (text: string): "tabs" | "spaces" | null => {
    const lines = text.split("\n").slice(0, INDENT_FILE_SAMPLE_LINES);
    let tabs = 0;
    let spaces = 0;
    for (const line of lines) {
        const ws = getLeadingWs(line);
        if (ws.length === 0) continue;
        if (isPureTabs(ws)) tabs += 1;
        else if (isPureSpaces(ws)) spaces += 1;
    }
    const total = tabs + spaces;
    if (total < INDENT_MIN_INDENTED_LINES) return null;
    if (tabs / total >= INDENT_DOMINANCE_THRESHOLD) return "tabs";
    if (spaces / total >= INDENT_DOMINANCE_THRESHOLD) return "spaces";
    return null;
};

const checkIndent = (input: EvaluateInput): string | null => {
    if (input.replace_all) return null;
    const lines = input.new_string.split("\n");
    const firstNonEmpty = lines.find((l) => l.trim().length > 0);
    if (firstNonEmpty === undefined) return null;
    const ws = getLeadingWs(firstNonEmpty);
    if (ws.length === 0) return null;
    const dominant = detectDominantIndent(input.original);
    if (dominant === null) return null;
    if (dominant === "spaces" && isPureTabs(ws)) {
        return "indent: new_string starts with tab indentation but the file is dominantly space-indented";
    }
    if (dominant === "tabs" && isPureSpaces(ws)) {
        return "indent: new_string starts with space indentation but the file is dominantly tab-indented";
    }
    return null;
};

export const evaluate = (input: EvaluateInput): readonly string[] => {
    const out: string[] = [];
    const push = (msg: string | null): void => {
        if (msg !== null && out.length < MAX_MESSAGES) out.push(truncate(msg));
    };
    push(checkConflictMarker(input.new_string));
    push(checkStub(input.new_string, input.old_string));
    push(checkCrlf(input.original, input.new_string));
    if (out.length < MAX_MESSAGES) push(checkNoopWhitespace(input));
    if (out.length < MAX_MESSAGES) push(checkDupBlock(input));
    if (out.length < MAX_MESSAGES) push(checkIndent(input));
    return out;
};
