// A minimal language server for tests: real Content-Length framing over stdio,
// canned answers. `mode` (argv[2]) picks the failure it simulates.
//   normal  — answers everything
//   chunked — answers everything, splitting each frame across three writes
//   silent  — completes the handshake, then never answers a query
//   die     — completes the handshake, then exits mid-query
const MODE = process.argv[2] ?? "normal";
let coldCalls = 0;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const frame = (payload: unknown): Uint8Array => {
    const body = encoder.encode(JSON.stringify(payload));
    const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
    const bytes = new Uint8Array(header.byteLength + body.byteLength);
    bytes.set(header, 0);
    bytes.set(body, header.byteLength);
    return bytes;
};

const respond = async (id: unknown, result: unknown): Promise<void> => {
    const bytes = frame({ jsonrpc: "2.0", id, result });
    if (MODE !== "chunked") {
        await Bun.write(Bun.stdout, bytes);
        return;
    }
    const cuts = [8, Math.floor(bytes.byteLength / 2), bytes.byteLength];
    let offset = 0;
    for (const cut of cuts) {
        if (cut <= offset) continue;
        await Bun.write(Bun.stdout, bytes.subarray(offset, cut));
        offset = cut;
        await sleep(5);
    }
};

const uriOf = (params: unknown): string => {
    const doc = isRecord(params) ? params["textDocument"] : undefined;
    const uri = isRecord(doc) ? doc["uri"] : undefined;
    return typeof uri === "string" ? uri : "file:///unknown";
};

const positionOf = (params: unknown): Record<string, unknown> => {
    const position = isRecord(params) ? params["position"] : undefined;
    return isRecord(position) ? position : { line: 0, character: 0 };
};

const at = (uri: string, line: number, character: number): Record<string, unknown> => ({
    uri,
    range: { start: { line, character }, end: { line, character: character + 4 } },
});

const handle = async (message: Record<string, unknown>): Promise<void> => {
    const method = message["method"];
    const id = message["id"];
    const params = message["params"];

    if (method === "initialize") {
        await respond(id, {
            capabilities: {
                textDocumentSync: 1,
                definitionProvider: true,
                referencesProvider: true,
                workspaceSymbolProvider: true,
            },
            serverInfo: { name: "fake-lsp" },
        });
        return;
    }
    if (method === "shutdown") {
        await respond(id, null);
        return;
    }
    if (method === "exit") process.exit(0);
    if (typeof id !== "number") return;

    if (MODE === "silent") return;
    if (MODE === "die") {
        await Bun.write(Bun.stderr, "fatal: fake server crashed\n");
        process.exit(3);
    }

    if (method === "textDocument/definition") {
        const echoed = positionOf(params);
        const uri = uriOf(params);
        // The first hit echoes the position we were asked about, so a test can
        // assert the 1-based → 0-based → 1-based round trip end to end.
        await respond(id, [
            { uri, range: { start: echoed, end: echoed } },
            at(`${uri.slice(0, uri.lastIndexOf("/"))}/other.ts`, 0, 0),
        ]);
        return;
    }

    if (method === "textDocument/references") {
        const uri = uriOf(params);
        const context = isRecord(params) ? params["context"] : undefined;
        const includeDeclaration = isRecord(context) && context["includeDeclaration"] === true;
        const dir = uri.slice(0, uri.lastIndexOf("/"));
        const locations = [at(`${dir}/use-b.ts`, 6, 2), at(`${dir}/use-a.ts`, 1, 0)];
        if (includeDeclaration) locations.push(at(uri, 41, 8));
        await respond(id, locations);
        return;
    }

    if (method === "workspace/symbol") {
        const query =
            isRecord(params) && typeof params["query"] === "string" ? params["query"] : "";
        // Reproduces tsserver's cold-project behaviour: an empty list, not an
        // error, until the project finishes building.
        if (MODE === "coldProject" && coldCalls++ < 2) {
            await respond(id, []);
            return;
        }
        await respond(id, [
            {
                name: `${query}Handler`,
                kind: 12,
                location: at("file:///workspace/src/handler.ts", 9, 0),
            },
            {
                name: `${query}Store`,
                kind: 5,
                containerName: "state",
                location: { uri: "file:///workspace/src/store.ts" },
            },
        ]);
        return;
    }

    await respond(id, null);
};

const CR = 13;
const LF = 10;

const separatorIndex = (buffer: Uint8Array): number => {
    for (let i = 0; i + 4 <= buffer.byteLength; i++) {
        if (
            buffer[i] === CR &&
            buffer[i + 1] === LF &&
            buffer[i + 2] === CR &&
            buffer[i + 3] === LF
        ) {
            return i;
        }
    }
    return -1;
};

let buffer = new Uint8Array(0);

for await (const chunk of Bun.stdin.stream()) {
    const next = new Uint8Array(buffer.byteLength + chunk.byteLength);
    next.set(buffer, 0);
    next.set(chunk, buffer.byteLength);
    buffer = next;

    for (;;) {
        const separator = separatorIndex(buffer);
        if (separator < 0) break;
        const header = decoder.decode(buffer.subarray(0, separator));
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (match?.[1] === undefined) {
            buffer = buffer.slice(separator + 4);
            continue;
        }
        const length = Number.parseInt(match[1], 10);
        const start = separator + 4;
        if (buffer.byteLength < start + length) break;
        const body: unknown = JSON.parse(decoder.decode(buffer.subarray(start, start + length)));
        buffer = buffer.slice(start + length);
        if (isRecord(body)) await handle(body);
    }
}
