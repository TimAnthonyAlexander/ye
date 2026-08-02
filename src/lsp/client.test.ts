import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient } from "./client.ts";
import { definitionAt, referencesAt, workspaceSymbols } from "./queries.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fakeServer.ts");

type Mode = "normal" | "chunked" | "silent" | "die";

let workDir: string;
let samplePath: string;
const clients: LspClient[] = [];

const startClient = async (mode: Mode, requestTimeoutMs?: number): Promise<LspClient> => {
    const client = new LspClient({
        command: process.execPath,
        args: [FIXTURE, mode],
        rootPath: workDir,
        ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    });
    clients.push(client);
    await client.start();
    return client;
};

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-lsp-test-"));
    samplePath = join(workDir, "sample.ts");
    await writeFile(samplePath, "export const value = 1;\n".repeat(10), "utf8");
});

afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.dispose()));
    await rm(workDir, { recursive: true, force: true });
});

describe("LspClient against a real framed fake server", () => {
    test("C1 initialize/initialized handshake completes and the server stays alive", async () => {
        const client = await startClient("normal");
        expect(client.alive).toBe(true);
    });

    test("C2 definition echoes the 0-based position it was sent", async () => {
        const client = await startClient("normal");
        const locations = await definitionAt(client, samplePath, "typescript", {
            line: 4,
            character: 2,
        });

        expect(locations.length).toBe(2);
        expect(locations[0]).toEqual({
            uri: pathToFileURL(samplePath).href,
            start: { line: 4, character: 2 },
        });
        expect(locations[1]?.uri.endsWith("/other.ts")).toBe(true);
    });

    test("C3 a response split across several writes reassembles", async () => {
        const client = await startClient("chunked");
        const locations = await definitionAt(client, samplePath, "typescript", {
            line: 11,
            character: 7,
        });

        expect(locations[0]?.start).toEqual({ line: 11, character: 7 });
    });

    test("C4 references passes includeDeclaration through", async () => {
        const client = await startClient("normal");
        const withDeclaration = await referencesAt(
            client,
            samplePath,
            "typescript",
            { line: 0, character: 0 },
            true,
        );
        const withoutDeclaration = await referencesAt(
            client,
            samplePath,
            "typescript",
            { line: 0, character: 0 },
            false,
        );

        expect(withDeclaration.length).toBe(3);
        expect(withoutDeclaration.length).toBe(2);
    });

    test("C5 workspace symbols normalize kind names and rangeless locations", async () => {
        const client = await startClient("normal");
        const symbols = await workspaceSymbols(client, "foo");

        expect(symbols.map((s) => s.kind)).toEqual(["Function", "Class"]);
        expect(symbols[0]?.name).toBe("fooHandler");
        expect(symbols[0]?.location.start).toEqual({ line: 9, character: 0 });
        expect(symbols[1]?.container).toBe("state");
        expect(symbols[1]?.location.start).toEqual({ line: 0, character: 0 });
    });

    test("C6 a server that never answers hits the request timeout", async () => {
        const client = await startClient("silent", 300);
        const started = Date.now();

        await expect(
            definitionAt(client, samplePath, "typescript", { line: 0, character: 0 }),
        ).rejects.toThrow(/did not answer textDocument\/definition within 300ms/);
        expect(Date.now() - started).toBeLessThan(5_000);
    });

    test("C7 a server that dies mid-request reports the exit, not a hang", async () => {
        const client = await startClient("die");

        await expect(
            definitionAt(client, samplePath, "typescript", { line: 0, character: 0 }),
        ).rejects.toThrow(/exited \(code 3\).*while awaiting textDocument\/definition/s);
        expect(client.alive).toBe(false);
    });

    test("C8 requests after the server died fail immediately with the same reason", async () => {
        const client = await startClient("die");
        await definitionAt(client, samplePath, "typescript", { line: 0, character: 0 }).catch(
            () => {},
        );

        await expect(client.request("textDocument/definition", {})).rejects.toThrow(/exited/);
    });

    test("C9 a command that does not exist fails to start with a clear message", async () => {
        const client = new LspClient({
            command: join(workDir, "definitely-not-a-language-server"),
            args: [],
            rootPath: workDir,
        });

        await expect(client.start()).rejects.toThrow(/failed to start language server/);
    });
});
