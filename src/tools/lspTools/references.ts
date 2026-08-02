import { resolveServerForFile } from "../../lsp/manager.ts";
import { referencesAt } from "../../lsp/queries.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import {
    absolutePath,
    attr,
    connectForFile,
    displayPath,
    MAX_ENTRIES,
    positionError,
    sortedUnique,
    startFailureMessage,
    toDisplay,
    toLspPosition,
    truncate,
} from "./shared.ts";

interface ReferencesArgs {
    readonly path: string;
    readonly line: number;
    readonly column: number;
    readonly includeDeclaration?: boolean;
}

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<ReferencesArgs>(rawArgs, ReferencesTool.schema);
    if (!v.ok) return v;
    const { line, column } = v.value;
    const includeDeclaration = v.value.includeDeclaration ?? true;

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
        locations = await referencesAt(
            client,
            path,
            target.languageId,
            toLspPosition(line, column),
            includeDeclaration,
        );
    } catch (error) {
        return { ok: false, error: startFailureMessage(target, error) };
    }

    const all = sortedUnique(locations.map((location) => toDisplay(location, ctx.cwd)));
    const kept = all.slice(0, MAX_ENTRIES);
    const omitted = all.length - kept.length;

    const shown = displayPath(path, ctx.cwd);
    const header =
        `<references path="${attr(shown)}" line="${line}" column="${column}" ` +
        `include_declaration="${includeDeclaration}" count="${all.length}">`;
    const body =
        kept.length > 0
            ? kept.join("\n") + (omitted > 0 ? `\n…(${omitted} more not shown)` : "")
            : "(no references found — the position may not be on a symbol, or the symbol may be unused)";

    return { ok: true, value: `${header}\n${truncate(body)}\n</references>` };
};

export const ReferencesTool: Tool = {
    name: "References",
    description:
        "Finds every USE of the symbol at a position, using the project's language server — resolved by symbol identity, so it will not match a same-named symbol from somewhere else. " +
        "`line` and `column` are 1-based (as shown by Read and Grep). `includeDeclaration` defaults to true. " +
        "Returns `file:line:column` per reference, sorted, capped at 500 entries and 32KB. " +
        "Call this before renaming or changing a signature; use Grep only when you have a name but no position.",
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        required: ["path", "line", "column"],
        properties: {
            path: { type: "string" },
            line: { type: "integer" },
            column: { type: "integer" },
            includeDeclaration: { type: "boolean" },
        },
    },
    execute,
};
