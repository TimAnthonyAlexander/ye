import { isAbsolute } from "node:path";
import { prettyPath } from "../../ui/path.ts";
import { hashContent } from "../fs.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface ReadArgs {
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
}

const DEFAULT_LIMIT = 2000;

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<ReadArgs>(rawArgs, ReadTool.schema);
    if (!v.ok) return v;
    const { path, offset = 0, limit = DEFAULT_LIMIT } = v.value;

    if (!isAbsolute(path)) {
        return { ok: false, error: "path must be absolute" };
    }

    const file = Bun.file(path);
    if (!(await file.exists())) {
        return { ok: false, error: `file not found: ${prettyPath(path, ctx.cwd)}` };
    }

    const text = await file.text();
    const allLines = text.split("\n");
    const sliced = allLines.slice(offset, offset + limit);
    const numbered = sliced
        .map((line, i) => `${String(offset + i + 1).padStart(6, " ")}\t${line}`)
        .join("\n");

    ctx.turnState.readFiles.set(path, { hash: hashContent(text) });

    const firstShown = sliced.length > 0 ? offset + 1 : 0;
    const lastShown = sliced.length > 0 ? offset + sliced.length : 0;
    const header = `<read path="${path}" lines="${allLines.length}" range="${firstShown}-${lastShown}">`;
    return { ok: true, value: `${header}\n${numbered}` };
};

export const ReadTool: Tool = {
    name: "Read",
    description:
        "Read a file from disk. With no offset/limit, returns the first 2000 lines — enough for most files in a single call. Use offset/limit only for files larger than that. Absolute paths only.",
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        required: ["path"],
        properties: {
            path: { type: "string" },
            offset: { type: "integer" },
            limit: { type: "integer" },
        },
    },
    execute,
};
