import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeFrame, FrameBuffer } from "./protocol.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 1_000;
const STDERR_TAIL_CAP = 2_000;

export interface LspClientOptions {
    readonly command: string;
    readonly args: readonly string[];
    readonly rootPath: string;
    readonly requestTimeoutMs?: number;
}

interface PendingRequest {
    readonly method: string;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export class LspClient {
    private readonly options: LspClientOptions;
    private readonly frames = new FrameBuffer();
    private readonly pending = new Map<number, PendingRequest>();
    private readonly openDocuments = new Set<string>();
    private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
    private nextId = 1;
    private stderrTail = "";
    private deathReason: string | undefined;

    constructor(options: LspClientOptions) {
        this.options = options;
    }

    get alive(): boolean {
        return this.proc !== undefined && this.deathReason === undefined;
    }

    async start(): Promise<void> {
        try {
            this.proc = Bun.spawn({
                cmd: [this.options.command, ...this.options.args],
                cwd: this.options.rootPath,
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
            });
        } catch (error) {
            throw new Error(
                `failed to start language server \`${this.options.command}\`: ${message(error)}`,
            );
        }

        const proc = this.proc;
        void this.readStdout(proc.stdout);
        void this.readStderr(proc.stderr);
        void proc.exited.then((code) => this.handleExit(code));

        const rootUri = pathToFileURL(this.options.rootPath).href;
        await this.request("initialize", {
            processId: process.pid,
            clientInfo: { name: "ye" },
            rootUri,
            workspaceFolders: [{ uri: rootUri, name: basename(this.options.rootPath) }],
            capabilities: {
                textDocument: {
                    synchronization: { dynamicRegistration: false },
                    definition: { linkSupport: true },
                    references: {},
                },
                workspace: { workspaceFolders: true, symbol: {} },
            },
        });
        this.notify("initialized", {});
    }

    request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
        if (this.deathReason !== undefined) return Promise.reject(new Error(this.deathReason));
        if (this.proc === undefined) {
            return Promise.reject(
                new Error(`language server \`${this.options.command}\` is not running`),
            );
        }

        const id = this.nextId++;
        const limit = timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(
                    new Error(
                        `language server \`${this.options.command}\` did not answer ${method} within ${limit}ms`,
                    ),
                );
            }, limit);
            this.pending.set(id, { method, resolve, reject, timer });
            try {
                this.write({ jsonrpc: "2.0", id, method, params });
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(
                    new Error(
                        `failed to send ${method} to \`${this.options.command}\`: ${message(error)}`,
                    ),
                );
            }
        });
    }

    notify(method: string, params: unknown): void {
        if (this.deathReason !== undefined || this.proc === undefined) return;
        try {
            this.write({ jsonrpc: "2.0", method, params });
        } catch {
            // A notification to a server that just died is not worth failing a
            // query the caller may still be able to answer from the response.
        }
    }

    async openDocument(path: string, languageId: string): Promise<void> {
        const uri = pathToFileURL(path).href;
        if (this.openDocuments.has(uri)) return;
        const text = await readFile(path, "utf8");
        this.notify("textDocument/didOpen", {
            textDocument: { uri, languageId, version: 1, text },
        });
        this.openDocuments.add(uri);
    }

    closeDocument(path: string): void {
        const uri = pathToFileURL(path).href;
        if (!this.openDocuments.delete(uri)) return;
        this.notify("textDocument/didClose", { textDocument: { uri } });
    }

    async dispose(): Promise<void> {
        if (this.alive) {
            await this.request("shutdown", null, SHUTDOWN_TIMEOUT_MS).catch(() => {});
            this.notify("exit", undefined);
        }
        this.openDocuments.clear();
        this.kill();
    }

    kill(): void {
        this.proc?.kill();
    }

    private write(payload: unknown): void {
        const proc = this.proc;
        if (proc === undefined) throw new Error("language server is not running");
        proc.stdin.write(encodeFrame(payload));
        proc.stdin.flush();
    }

    private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
        const reader = stream.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            this.frames.append(value);
            for (const incoming of this.frames.drain()) this.handleMessage(incoming);
        }
    }

    private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
        const decoder = new TextDecoder();
        const reader = stream.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            this.stderrTail = (this.stderrTail + decoder.decode(value, { stream: true })).slice(
                -STDERR_TAIL_CAP,
            );
        }
    }

    private handleMessage(incoming: unknown): void {
        if (!isRecord(incoming)) return;
        const id = incoming["id"];

        // Server-initiated requests (workspace/configuration,
        // client/registerCapability, …). Some servers stall their own startup
        // waiting for the answer, so every one gets a null result.
        if (typeof incoming["method"] === "string") {
            if (typeof id === "number" || typeof id === "string") {
                try {
                    this.write({ jsonrpc: "2.0", id, result: null });
                } catch {
                    // Server died; pending requests are rejected by handleExit.
                }
            }
            return;
        }

        if (typeof id !== "number") return;
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);

        const error = incoming["error"];
        if (isRecord(error)) {
            pending.reject(
                new Error(`${pending.method} failed: ${String(error["message"] ?? error)}`),
            );
            return;
        }
        pending.resolve(incoming["result"]);
    }

    private handleExit(code: number | null): void {
        const detail = this.stderrTail.trim();
        this.deathReason =
            `language server \`${this.options.command}\` exited (code ${code ?? "unknown"})` +
            (detail.length > 0 ? `: ${detail}` : "");

        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const request of pending) {
            clearTimeout(request.timer);
            request.reject(new Error(`${this.deathReason} while awaiting ${request.method}`));
        }
    }
}
