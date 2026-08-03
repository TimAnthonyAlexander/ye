import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    configuredTargets,
    getClient,
    isLspEnabled,
    type LanguageServerTarget,
} from "../../lsp/manager.ts";
import { languageForPath } from "../../lsp/languages.ts";
import type { LspClient } from "../../lsp/client.ts";
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

const WARMUP_DIRS = ["src", "lib", "app", "."];
const READY_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 200;

// The file must belong to the SAME server, or a mixed repo opens a .ts document
// against gopls.
const findWarmupFile = (root: string, configKey: string): string | undefined => {
    for (const dir of WARMUP_DIRS) {
        let entries: readonly string[];
        try {
            entries = readdirSync(join(root, dir));
        } catch {
            continue;
        }
        for (const entry of entries) {
            const path = join(root, dir, entry);
            if (languageForPath(path)?.configKeys.includes(configKey) === true) return path;
        }
    }
    return undefined;
};

// A language server builds its project asynchronously after the first didOpen,
// and until it finishes tsserver answers workspace/symbol with an EMPTY LIST
// rather than an error — a silent wrong answer that reads as "no such symbol".
// Opening a document is necessary but not sufficient, so poll until results
// arrive. A query with genuinely no matches waits out the full timeout; that is
// the price of not reporting a cold project as an empty workspace.
// A cold server answers a workspace query by throwing ("No Project") or by
// returning an empty list, and both look exactly like a genuine no-match.
// Readiness cannot be judged by "did the probe return anything" either: until
// the real project loads, tsserver serves a single-file inferred project and
// happily answers from the warmup file alone. So the signal is a symbol
// resolving in a DIFFERENT file — that is only possible once the project spans
// the workspace.
const READINESS_QUERY = "a";

const projectReady = async (
    client: LspClient,
    warmupPath: string,
    deadline: number,
): Promise<void> => {
    for (;;) {
        try {
            const probe = await workspaceSymbols(client, READINESS_QUERY);
            if (probe.some((symbol) => symbol.location.uri !== pathToFileURL(warmupPath).href)) {
                return;
            }
        } catch {
            // Still building: a cold tsserver throws rather than answering empty.
        }
        if (Date.now() >= deadline) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
};

// The warmup document must be opened on EVERY call, not once per client. It is
// closed again below so the server's copy cannot go stale, and a server with no
// open document discards the project — so a "we already warmed this client"
// shortcut makes the very next query fail outright.
const warmupSymbols = async (
    client: LspClient,
    query: string,
    root: string,
    target: LanguageServerTarget,
): Promise<readonly LspSymbol[]> => {
    const path = findWarmupFile(root, target.configKey);
    if (path === undefined) return workspaceSymbols(client, query);

    const languageId = languageForPath(path)?.languageId ?? target.languageId;
    try {
        await client.openDocument(path, languageId);
    } catch {
        return workspaceSymbols(client, query);
    }

    try {
        await projectReady(client, path, Date.now() + READY_TIMEOUT_MS);
        // Deliberately unguarded: if the project never came up, the real query
        // raises the server's own error instead of reporting an empty workspace.
        return await workspaceSymbols(client, query);
    } finally {
        client.closeDocument(path);
    }
};

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

    if (!isLspEnabled(ctx.config, ctx.cwd)) {
        return { ok: false, error: unavailableMessage({ ok: false, reason: "disabled" }) };
    }

    const results = await Promise.all(
        configuredTargets(ctx.config, ctx.cwd).map(async (target) => {
            try {
                const client = await getClient(target, ctx.cwd);
                return {
                    symbols: await warmupSymbols(client, query, ctx.cwd, target),
                    failure: undefined,
                };
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
