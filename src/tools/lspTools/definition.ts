import { resolveServerForFile } from "../../lsp/manager.ts";
import { definitionAt } from "../../lsp/queries.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import {
    absolutePath,
    attr,
    connectForFile,
    displayPath,
    positionError,
    sortedUnique,
    startFailureMessage,
    toDisplay,
    toLspPosition,
    truncate,
} from "./shared.ts";

interface DefinitionArgs {
    readonly path: string;
    readonly line: number;
    readonly column: number;
}

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<DefinitionArgs>(rawArgs, DefinitionTool.schema);
    if (!v.ok) return v;
    const { line, column } = v.value;

    const badPosition = positionError(line, column);
    if (badPosition !== undefined) return { ok: false, error: badPosition };

    const path = absolutePath(v.value.path, ctx.cwd);
    if (!(await Bun.file(path).exists())) return { ok: false, error: `file not found: ${path}` };

    const lookup = resolveServerForFile(ctx.config, path, ctx.cwd);
    const connected = await connectForFile(ctx, lookup);
    if (!connected.ok) return connected;
    const { client, target } = connected.value;

    let locations;
    try {
        locations = await definitionAt(
            client,
            path,
            target.languageId,
            toLspPosition(line, column),
        );
    } catch (error) {
        return { ok: false, error: startFailureMessage(target, error) };
    }

    const shown = displayPath(path, ctx.cwd);
    const lines = sortedUnique(locations.map((location) => toDisplay(location, ctx.cwd)));
    const header = `<definition path="${attr(shown)}" line="${line}" column="${column}" count="${lines.length}">`;
    const body =
        lines.length > 0
            ? lines.join("\n")
            : `(no definition found — the position may not be on a symbol, or the symbol may be defined outside this workspace)`;

    return { ok: true, value: `${header}\n${truncate(body)}\n</definition>` };
};

export const DefinitionTool: Tool = {
    name: "Definition",
    description:
        "Jumps to where the symbol at a position is DEFINED, using the project's language server — real symbol resolution, not a name search. " +
        "`line` and `column` are 1-based (as shown by Read and Grep) and point at the symbol you are asking about. " +
        "Returns the defining location(s) as `file:line:column`. " +
        "Use this instead of guessing which of several same-named declarations is the right one; use Grep when you only have a name and no position.",
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        required: ["path", "line", "column"],
        properties: {
            path: { type: "string" },
            line: { type: "integer" },
            column: { type: "integer" },
        },
    },
    execute,
};
