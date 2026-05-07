import { isAbsolute } from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface EditArgs {
    readonly path: string;
    readonly old_string: string;
    readonly new_string: string;
    readonly replace_all?: boolean;
}

const execute = async (
    rawArgs: unknown,
    ctx: ToolContext,
): Promise<ToolResult<{ replacements: number }>> => {
    const v = validateArgs<EditArgs>(rawArgs, EditTool.schema);
    if (!v.ok) return v;
    const { path, old_string, new_string, replace_all = false } = v.value;

    if (!isAbsolute(path)) {
        return { ok: false, error: "path must be absolute" };
    }
    if (!ctx.turnState.readFiles.has(path)) {
        return {
            ok: false,
            error: `Read ${path} before editing it (turn-local invariant).`,
        };
    }
    if (old_string === new_string) {
        return { ok: false, error: "old_string and new_string are identical" };
    }

    const file = Bun.file(path);
    if (!(await file.exists())) {
        return { ok: false, error: `file not found: ${path}` };
    }

    const original = await file.text();
    let updated: string;
    let replacements: number;

    if (replace_all) {
        const parts = original.split(old_string);
        replacements = parts.length - 1;
        if (replacements === 0) {
            return { ok: false, error: "old_string not found" };
        }
        updated = parts.join(new_string);
    } else {
        const idx = original.indexOf(old_string);
        if (idx === -1) {
            return { ok: false, error: "old_string not found" };
        }
        if (original.indexOf(old_string, idx + old_string.length) !== -1) {
            return {
                ok: false,
                error: "old_string is not unique in the file (use replace_all or expand the match)",
            };
        }
        updated = original.slice(0, idx) + new_string + original.slice(idx + old_string.length);
        replacements = 1;
    }

    await Bun.write(path, updated);
    return { ok: true, value: { replacements } };
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
