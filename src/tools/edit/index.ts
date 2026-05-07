import { isAbsolute } from "node:path";
import { atomicWrite, hashContent } from "../fs.ts";
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
    const entry = ctx.turnState.readFiles.get(path);
    if (!entry) {
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
    if (hashContent(original) !== entry.hash) {
        return {
            ok: false,
            error: `${path} has been modified since you last Read it. Re-Read the file before editing.`,
        };
    }

    const parts = original.split(old_string);
    const matches = parts.length - 1;
    if (matches === 0) {
        return {
            ok: false,
            error: `old_string not found in ${path}. Re-Read the file — whitespace or contents may differ from what you copied.`,
        };
    }
    if (matches > 1 && !replace_all) {
        return {
            ok: false,
            error: `old_string matches ${matches} occurrences in ${path}. Add surrounding context to make it unique, or set replace_all: true.`,
        };
    }

    const updated = replace_all
        ? parts.join(new_string)
        : parts[0] + new_string + parts.slice(1).join(old_string);

    await atomicWrite(path, updated);
    ctx.turnState.readFiles.set(path, { hash: hashContent(updated) });

    return { ok: true, value: { replacements: replace_all ? matches : 1 } };
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
