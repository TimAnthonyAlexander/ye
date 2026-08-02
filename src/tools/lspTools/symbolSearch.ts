import { configuredTargets, getClient, isLspEnabled } from "../../lsp/manager.ts";
import { workspaceSymbols, type LspSymbol } from "../../lsp/queries.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import {
    attr,
    MAX_ENTRIES,
    startFailureMessage,
    toDisplay,
    truncate,
    unavailableMessage,
} from "./shared.ts";

interface SymbolSearchArgs {
    readonly query: string;
}

const describe = (symbol: LspSymbol, cwd: string): string =>
    `${symbol.kind} ${symbol.name}${symbol.container ? ` (in ${symbol.container})` : ""} — ` +
    toDisplay(symbol.location, cwd);

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<SymbolSearchArgs>(rawArgs, SymbolSearchTool.schema);
    if (!v.ok) return v;
    const query = v.value.query.trim();
    if (query.length === 0) return { ok: false, error: "arg query must not be empty" };

    if (!isLspEnabled(ctx.config)) {
        return { ok: false, error: unavailableMessage({ ok: false, reason: "disabled" }) };
    }

    const results = await Promise.all(
        configuredTargets(ctx.config).map(async (target) => {
            try {
                const client = await getClient(target, ctx.cwd);
                return { symbols: await workspaceSymbols(client, query), failure: undefined };
            } catch (error) {
                return { symbols: [], failure: startFailureMessage(target, error) };
            }
        }),
    );

    const failures = results.map((r) => r.failure).filter((f): f is string => f !== undefined);
    const symbols = results.flatMap((r) => r.symbols);
    if (symbols.length === 0 && failures.length === results.length) {
        return { ok: false, error: failures.join(" ") };
    }

    const lines = [...new Set(symbols.map((symbol) => describe(symbol, ctx.cwd)))].sort((a, b) =>
        a.localeCompare(b),
    );
    const kept = lines.slice(0, MAX_ENTRIES);
    const omitted = lines.length - kept.length;

    const parts: string[] = [];
    if (kept.length > 0) parts.push(kept.join("\n"));
    else parts.push(`(no workspace symbol matches "${query}")`);
    if (omitted > 0) parts.push(`…(${omitted} more not shown)`);
    for (const failure of failures) parts.push(`(${failure})`);

    return {
        ok: true,
        value:
            `<symbol_search query="${attr(query)}" count="${lines.length}">\n` +
            `${truncate(parts.join("\n"))}\n</symbol_search>`,
    };
};

export const SymbolSearchTool: Tool = {
    name: "SymbolSearch",
    description:
        "Searches the workspace for symbols by name using the project's language server — declarations only (classes, functions, methods, constants), not every text match. " +
        "`query` is matched by the server, usually as a fuzzy substring. " +
        "Returns `Kind Name — file:line:column` per hit, sorted, capped at 500 entries. " +
        "Use it to locate a definition when you know a name but not a file; use Grep when you need arbitrary text rather than declared symbols.",
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        required: ["query"],
        properties: {
            query: { type: "string" },
        },
    },
    execute,
};
