import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getClient, type LanguageServerTarget, type ServerLookup } from "../../lsp/manager.ts";
import type { LspClient } from "../../lsp/client.ts";
import type { LspLocation, LspPosition } from "../../lsp/queries.ts";
import type { ToolContext, ToolResult } from "../types.ts";

export const OUTPUT_CAP = 32_000;
export const MAX_ENTRIES = 500;

const CONFIG_EXAMPLE =
    '{"lsp": {"enabled": true, "servers": {"typescript": {"command": "typescript-language-server", "args": ["--stdio"]}}}}';

const NOT_YOUR_FAULT =
    "This is a missing setting, not a failure of your work: nothing you did caused it and re-calling this tool returns the same message.";

export const unavailableMessage = (lookup: Extract<ServerLookup, { ok: false }>): string => {
    switch (lookup.reason) {
        case "disabled":
            return (
                "Language-server navigation is off: `lsp.enabled` is not true in ~/.ye/config.json (or no servers are listed). " +
                `Enable it and add a server under \`lsp.servers.<language>\` — for example ${CONFIG_EXAMPLE}. ` +
                `Until then, use Grep to search for the symbol by name. ${NOT_YOUR_FAULT}`
            );
        case "unmapped":
            return (
                `No language id is mapped for \`${lookup.extension || "extension-less"}\` files, so there is no language server to ask. ` +
                `Use Grep to search for the symbol by name instead. ${NOT_YOUR_FAULT}`
            );
        case "unconfigured":
            return (
                `No language server is configured for ${lookup.languageId} files. ` +
                `Add one under \`lsp.servers.${lookup.configKeys[0]}\` in ~/.ye/config.json — the shape is ${CONFIG_EXAMPLE}. ` +
                `Until then, use Grep to search for the symbol by name. ${NOT_YOUR_FAULT}`
            );
    }
};

export const startFailureMessage = (target: LanguageServerTarget, error: unknown): string =>
    `The ${target.configKey} language server (\`${target.server.command}\`) could not answer: ` +
    `${error instanceof Error ? error.message : String(error)}. ` +
    "Check that the command in `lsp.servers` is installed and speaks LSP over stdio, or use Grep instead.";

export const attr = (value: string): string => value.replaceAll('"', "&quot;");

export const truncate = (text: string): string =>
    text.length > OUTPUT_CAP
        ? `${text.slice(0, OUTPUT_CAP)}\n…(truncated, ${text.length - OUTPUT_CAP} more chars)`
        : text;

export const displayPath = (path: string, cwd: string): string => {
    const rel = relative(cwd, path);
    return rel.length > 0 && !rel.startsWith("..") ? rel : path;
};

// LSP is 0-based on both axes; the tool API is 1-based on both.
export const toDisplay = (location: LspLocation, cwd: string): string => {
    let path: string;
    try {
        path = fileURLToPath(location.uri);
    } catch {
        return `${location.uri}:${location.start.line + 1}:${location.start.character + 1}`;
    }
    return `${displayPath(path, cwd)}:${location.start.line + 1}:${location.start.character + 1}`;
};

export const sortedUnique = (lines: readonly string[]): readonly string[] =>
    [...new Set(lines)].sort((a, b) => a.localeCompare(b));

export const toLspPosition = (line: number, column: number): LspPosition => ({
    line: line - 1,
    character: column - 1,
});

export const positionError = (line: number, column: number): string | undefined => {
    if (!Number.isInteger(line) || line < 1) return "arg line must be a 1-based integer (>= 1)";
    if (!Number.isInteger(column) || column < 1)
        return "arg column must be a 1-based integer (>= 1)";
    return undefined;
};

export interface Connection {
    readonly client: LspClient;
    readonly target: LanguageServerTarget;
}

export const connectForFile = async (
    ctx: ToolContext,
    lookup: ServerLookup,
): Promise<ToolResult<Connection>> => {
    if (!lookup.ok) return { ok: false, error: unavailableMessage(lookup) };
    try {
        const client = await getClient(lookup.target, ctx.cwd);
        return { ok: true, value: { client, target: lookup.target } };
    } catch (error) {
        return { ok: false, error: startFailureMessage(lookup.target, error) };
    }
};

export const absolutePath = (path: string, cwd: string): string =>
    isAbsolute(path) ? path : join(cwd, path);
