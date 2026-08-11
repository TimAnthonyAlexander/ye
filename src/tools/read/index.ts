import { collectNestedNotes } from "../../memory/index.ts";
import { prettyPath } from "../../ui/path.ts";
import { hashContent } from "../fs.ts";
import { toAbsolutePath } from "../paths.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface ReadArgs {
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
}

const DEFAULT_LIMIT = 2000;

// Nested notes are injected at most once per session, so the set outlives any
// single turn — turnState resets every turn and cannot hold this.
const injectedNotes = new Set<string>();

const nestedNotesReminder = async (path: string, ctx: ToolContext): Promise<string> => {
    const notes = await collectNestedNotes(path, ctx.cwd);
    const fresh = notes.filter(
        (n) => n.path !== path && !injectedNotes.has(`${ctx.sessionId}\u0000${n.path}`),
    );
    if (fresh.length === 0) return "";

    for (const n of fresh) injectedNotes.add(`${ctx.sessionId}\u0000${n.path}`);

    const blocks = fresh.map((n) => `----- ${n.path} -----\n\n${n.content}`).join("\n\n");
    return `\n<system-reminder>\nNested project notes that apply to this file's directory and everything below it:\n\n${blocks}\n</system-reminder>`;
};

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<ReadArgs>(rawArgs, ReadTool.schema);
    if (!v.ok) return v;
    const { offset = 0, limit = DEFAULT_LIMIT } = v.value;
    const path = toAbsolutePath(v.value.path, ctx.cwd);

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
    const notes = await nestedNotesReminder(path, ctx);
    return { ok: true, value: `${header}\n${numbered}${notes}` };
};

export const ReadTool: Tool = {
    name: "Read",
    description:
        "Read a file from disk. With no offset/limit, returns the first 2000 lines — enough for most files in a single call. Use offset/limit only for files larger than that. `path` may be absolute, `~`-prefixed, or relative to the working directory.",
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
