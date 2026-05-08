import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const MAX_DEPTH = 4;
const MAX_ENTRIES = 200;

const collect = (root: string): readonly string[] => {
    const out: string[] = [];
    const walk = (current: string, depth: number): void => {
        if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
        let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[] = [];
        try {
            entries = readdirSync(current, { withFileTypes: true, encoding: "utf-8" });
        } catch {
            return;
        }
        for (const e of entries) {
            if (out.length >= MAX_ENTRIES) return;
            if (e.name.startsWith(".")) continue;
            const full = join(current, e.name);
            if (e.isDirectory()) {
                walk(full, depth + 1);
                continue;
            }
            if (!e.isFile()) continue;
            // Skip the top-level SKILL.md only; deeper SKILL.md files (rare,
            // but possible if someone bundles example skills as references)
            // are still listed as supporting content.
            if (depth === 0 && e.name === "SKILL.md") continue;
            out.push(full);
        }
    };
    walk(root, 0);
    return out.sort();
};

export const formatSupportingFiles = (skillDir: string): string => {
    const files = collect(skillDir);
    if (files.length === 0) return "";

    const lines = files.map((abs) => `  ${relative(skillDir, abs)}    →    ${abs}`);
    const truncated = files.length >= MAX_ENTRIES ? `\n  …(truncated at ${MAX_ENTRIES})` : "";

    return [
        "## Supporting files",
        "",
        "These ship inside this skill's directory. The body references them by relative path; the absolute path on the right is what you pass to Read or Bash. Read on demand — do not pre-load all of them.",
        "",
        lines.join("\n") + truncated,
    ].join("\n");
};
