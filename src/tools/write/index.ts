import { isAbsolute } from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface WriteArgs {
    readonly path: string;
    readonly content: string;
}

const execute = async (
    rawArgs: unknown,
    ctx: ToolContext,
): Promise<ToolResult<{ bytes: number }>> => {
    const v = validateArgs<WriteArgs>(rawArgs, WriteTool.schema);
    if (!v.ok) return v;
    const { path, content } = v.value;

    if (!isAbsolute(path)) {
        return { ok: false, error: "path must be absolute" };
    }

    const file = Bun.file(path);
    if (await file.exists()) {
        if (!ctx.turnState.readFiles.has(path)) {
            return {
                ok: false,
                error: `Read ${path} before overwriting it (turn-local invariant).`,
            };
        }
    }

    const bytes = await Bun.write(path, content);
    // Once written, this counts as read for subsequent edits in the same turn.
    ctx.turnState.readFiles.add(path);
    return { ok: true, value: { bytes } };
};

export const WriteTool: Tool = {
    name: "Write",
    description:
        "Create or overwrite a file. If the file already exists, prior Read in the same turn is required.",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["path", "content"],
        properties: {
            path: { type: "string" },
            content: { type: "string" },
        },
    },
    execute,
};
