import { isAbsolute } from "node:path";
import { prettyPath } from "../../ui/path.ts";
import { atomicWrite, hashContent } from "../fs.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface EditArgs {
    readonly path: string;
    readonly old_string: string;
    readonly new_string: string;
    readonly replace_all?: boolean;
}

interface EditValue {
    readonly replacements: number;
    readonly line: number;
    readonly preview: string;
}

const PREVIEW_RADIUS = 3;
const MAX_OCCURRENCE_LOCATIONS = 3;

// Walk every match of `needle` in `text` once, recording line:col for the
// first `max` hits and the total count. Single pass — line/col counters
// advance from the previous hit, never from index 0.
const findOccurrences = (
    text: string,
    needle: string,
    max: number,
): { locations: readonly string[]; total: number } => {
    const locations: string[] = [];
    let line = 1;
    let col = 1;
    let cursor = 0;
    let total = 0;
    let from = 0;
    while (true) {
        const idx = text.indexOf(needle, from);
        if (idx === -1) break;
        while (cursor < idx) {
            if (text.charCodeAt(cursor) === 10) {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
            cursor += 1;
        }
        total += 1;
        if (locations.length < max) {
            locations.push(`${line}:${col}`);
        }
        from = idx + needle.length;
    }
    return { locations, total };
};

// Render ~PREVIEW_RADIUS lines before and after the change site, with
// 1-indexed line numbers in the same `<padded>\t<content>` format as Read.
const buildPreview = (
    updated: string,
    siteLineIdx: number,
    newStringLineSpan: number,
): { line: number; preview: string } => {
    const lines = updated.split("\n");
    const startLine = Math.max(0, siteLineIdx - PREVIEW_RADIUS);
    const endLine = Math.min(lines.length, siteLineIdx + newStringLineSpan + PREVIEW_RADIUS);
    const preview = lines
        .slice(startLine, endLine)
        .map((l, i) => `${String(startLine + i + 1).padStart(6, " ")}\t${l}`)
        .join("\n");
    return { line: siteLineIdx + 1, preview };
};

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<EditValue>> => {
    const v = validateArgs<EditArgs>(rawArgs, EditTool.schema);
    if (!v.ok) return v;
    const { path, old_string, new_string, replace_all = false } = v.value;

    if (!isAbsolute(path)) {
        return { ok: false, error: "path must be absolute" };
    }
    if (old_string === "") {
        return { ok: false, error: "old_string must not be empty" };
    }
    if (old_string === new_string) {
        return { ok: false, error: "old_string and new_string are identical" };
    }
    const display = prettyPath(path, ctx.cwd);
    const entry = ctx.turnState.readFiles.get(path);
    if (!entry) {
        return {
            ok: false,
            error: `Read ${display} before editing it (turn-local invariant).`,
        };
    }

    const file = Bun.file(path);
    if (!(await file.exists())) {
        return { ok: false, error: `file not found: ${display}` };
    }

    const original = await file.text();
    if (hashContent(original) !== entry.hash) {
        return {
            ok: false,
            error: `${display} has been modified since you last Read it. Re-Read the file before editing.`,
        };
    }

    const { locations, total } = findOccurrences(original, old_string, MAX_OCCURRENCE_LOCATIONS);
    if (total === 0) {
        return {
            ok: false,
            error: `old_string not found in ${display}. Re-Read the file — whitespace or contents may differ from what you copied.`,
        };
    }
    if (total > 1 && !replace_all) {
        const more = total > locations.length ? ` (+${total - locations.length} more)` : "";
        return {
            ok: false,
            error: `old_string matches ${total} occurrences at line:col ${locations.join(", ")}${more} in ${display}. Add surrounding context to make it unique, or set replace_all: true.`,
        };
    }

    const firstIdx = original.indexOf(old_string);
    const updated = replace_all
        ? original.split(old_string).join(new_string)
        : original.slice(0, firstIdx) + new_string + original.slice(firstIdx + old_string.length);

    await atomicWrite(path, updated, { preserveMode: true });
    ctx.turnState.readFiles.set(path, { hash: hashContent(updated) });

    const siteLineIdx = updated.slice(0, firstIdx).split("\n").length - 1;
    const newStringLineSpan = new_string.split("\n").length;
    const { line, preview } = buildPreview(updated, siteLineIdx, newStringLineSpan);

    return {
        ok: true,
        value: {
            replacements: replace_all ? total : 1,
            line,
            preview,
        },
    };
};

export const EditTool: Tool = {
    name: "Edit",
    description:
        "Exact-string replace in a file. Requires prior Read of the same file in this turn. " +
        "Use replace_all to replace every occurrence.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["path", "old_string", "new_string"],
        properties: {
            path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
        },
    },
    execute,
};
