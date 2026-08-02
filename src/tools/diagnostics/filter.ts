import { isAbsolute, relative, resolve } from "node:path";

// Checkers spell paths differently: absolute (eslint), cwd-relative (tsc), or
// "./"-prefixed. Carrying both the absolute and the cwd-relative spelling of
// each requested path covers all three as substring matches.
export const pathNeedles = (paths: readonly string[], cwd: string): readonly string[] => {
    const needles: string[] = [];
    for (const p of paths) {
        const abs = isAbsolute(p) ? p : resolve(cwd, p);
        needles.push(abs);
        const rel = relative(cwd, abs);
        if (rel.length > 0 && !rel.startsWith("..")) needles.push(rel);
    }
    return needles;
};

// Indented lines (code frames, eslint's per-file message blocks) name no path
// of their own, so they inherit the keep/drop decision of the line above them.
export const filterByPaths = (output: string, needles: readonly string[]): string => {
    const kept: string[] = [];
    let keeping = false;
    for (const line of output.split("\n")) {
        const isContinuation = line.trim().length > 0 && /^\s/.test(line);
        if (!isContinuation) keeping = needles.some((n) => line.includes(n));
        if (keeping) kept.push(line);
    }
    return kept.join("\n");
};
