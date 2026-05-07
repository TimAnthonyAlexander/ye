import { isAbsolute } from "node:path";
import { atomicWrite, hashContent } from "../fs.ts";
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
    const fileExists = await file.exists();
    if (fileExists) {
        const entry = ctx.turnState.readFiles.get(path);
        if (!entry) {
            return {
                ok: false,
                error: `Read ${path} before overwriting it (turn-local invariant).`,
            };
        }
        const original = await file.text();
        if (hashContent(original) !== entry.hash) {
            return {
                ok: false,
                error: `${path} has been modified since you last Read it. Re-Read the file before overwriting.`,
            };
        }
    }

    await atomicWrite(path, content, { preserveMode: fileExists });
    // Once written, this counts as read for subsequent edits in the same turn.
    ctx.turnState.readFiles.set(path, { hash: hashContent(content) });
    return { ok: true, value: { bytes: Buffer.byteLength(content, "utf8") } };
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
