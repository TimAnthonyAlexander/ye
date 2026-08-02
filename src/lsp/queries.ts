import { pathToFileURL } from "node:url";
import type { LspClient } from "./client.ts";

// All positions here are LSP-native: 0-based line and character.
export interface LspPosition {
    readonly line: number;
    readonly character: number;
}

export interface LspLocation {
    readonly uri: string;
    readonly start: LspPosition;
}

export interface LspSymbol {
    readonly name: string;
    readonly kind: string;
    readonly container: string | undefined;
    readonly location: LspLocation;
}

const SYMBOL_KIND_NAMES: readonly string[] = [
    "File",
    "Module",
    "Namespace",
    "Package",
    "Class",
    "Method",
    "Property",
    "Field",
    "Constructor",
    "Enum",
    "Interface",
    "Function",
    "Variable",
    "Constant",
    "String",
    "Number",
    "Boolean",
    "Array",
    "Object",
    "Key",
    "Null",
    "EnumMember",
    "Struct",
    "Event",
    "Operator",
    "TypeParameter",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const positionOf = (range: unknown): LspPosition => {
    const start = isRecord(range) ? range["start"] : undefined;
    if (!isRecord(start)) return { line: 0, character: 0 };
    const line = typeof start["line"] === "number" ? start["line"] : 0;
    const character = typeof start["character"] === "number" ? start["character"] : 0;
    return { line, character };
};

// Definition results come back as Location, Location[], or LocationLink[]
// depending on the server and on whether it honoured our linkSupport flag.
const toLocation = (entry: unknown): LspLocation | undefined => {
    if (!isRecord(entry)) return undefined;
    const uri = entry["uri"] ?? entry["targetUri"];
    if (typeof uri !== "string") return undefined;
    const range = entry["range"] ?? entry["targetSelectionRange"] ?? entry["targetRange"];
    return { uri, start: positionOf(range) };
};

export const normalizeLocations = (result: unknown): readonly LspLocation[] => {
    const entries = Array.isArray(result) ? result : [result];
    const locations: LspLocation[] = [];
    for (const entry of entries) {
        const location = toLocation(entry);
        if (location !== undefined) locations.push(location);
    }
    return locations;
};

export const normalizeSymbols = (result: unknown): readonly LspSymbol[] => {
    if (!Array.isArray(result)) return [];
    const symbols: LspSymbol[] = [];
    for (const entry of result) {
        if (!isRecord(entry)) continue;
        const name = entry["name"];
        if (typeof name !== "string") continue;
        const location = toLocation(entry["location"]);
        if (location === undefined) continue;
        const kindIndex = typeof entry["kind"] === "number" ? entry["kind"] : 0;
        const container = entry["containerName"];
        symbols.push({
            name,
            kind: SYMBOL_KIND_NAMES[kindIndex - 1] ?? `Kind${kindIndex}`,
            container:
                typeof container === "string" && container.length > 0 ? container : undefined,
            location,
        });
    }
    return symbols;
};

const withDocument = async <T>(
    client: LspClient,
    path: string,
    languageId: string,
    run: () => Promise<T>,
): Promise<T> => {
    await client.openDocument(path, languageId);
    try {
        return await run();
    } finally {
        client.closeDocument(path);
    }
};

const textDocumentParams = (path: string, position: LspPosition): Record<string, unknown> => ({
    textDocument: { uri: pathToFileURL(path).href },
    position,
});

export const definitionAt = (
    client: LspClient,
    path: string,
    languageId: string,
    position: LspPosition,
): Promise<readonly LspLocation[]> =>
    withDocument(client, path, languageId, async () =>
        normalizeLocations(
            await client.request("textDocument/definition", textDocumentParams(path, position)),
        ),
    );

export const referencesAt = (
    client: LspClient,
    path: string,
    languageId: string,
    position: LspPosition,
    includeDeclaration: boolean,
): Promise<readonly LspLocation[]> =>
    withDocument(client, path, languageId, async () =>
        normalizeLocations(
            await client.request("textDocument/references", {
                ...textDocumentParams(path, position),
                context: { includeDeclaration },
            }),
        ),
    );

export const workspaceSymbols = async (
    client: LspClient,
    query: string,
): Promise<readonly LspSymbol[]> =>
    normalizeSymbols(await client.request("workspace/symbol", { query }));
