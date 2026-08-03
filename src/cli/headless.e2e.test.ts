import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_VERSION } from "../update/version.ts";

const CLI = fileURLToPath(new URL("../cli.tsx", import.meta.url));

// Points at a dead local port: every provider call fails fast, so the whole
// pipeline runs end to end without a network round-trip or an API key.
const CONFIG = {
    defaultProvider: "ollama",
    providers: { ollama: { baseUrl: "http://127.0.0.1:9", apiKeyEnv: "OLLAMA_API_KEY" } },
    defaultModel: { provider: "ollama", model: "e2e-test-model" },
    recovery: { maxRetries: 0 },
};

interface RunResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

const REPLY = ["Hello ", "world"];

interface ChatMessage {
    readonly role: string;
    readonly content: string | null;
}

// The messages the CLI subprocess sent on its most recent chat call. The server
// runs in the test process, so a resumed run's replayed history is observable.
let lastChatMessages: readonly ChatMessage[] = [];

// Minimal ollama /api/chat stand-in: NDJSON deltas plus the terminating
// done chunk, so a headless run can succeed without a real model.
const startFakeOllama = (): { readonly port: number; stop(): void } => {
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            if (!new URL(req.url).pathname.endsWith("/api/chat")) {
                return new Response("not found", { status: 404 });
            }
            const body = (await req.json()) as { readonly messages?: readonly ChatMessage[] };
            lastChatMessages = body.messages ?? [];
            const lines = [
                ...REPLY.map((content) => ({ message: { role: "assistant", content } })),
                { done: true, done_reason: "stop", prompt_eval_count: 11, eval_count: 5 },
            ];
            return new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), {
                headers: { "Content-Type": "application/x-ndjson" },
            });
        },
    });
    const port = server.port;
    if (port === undefined) throw new Error("fake ollama server did not bind a port");
    return { port, stop: () => void server.stop(true) };
};

let home = "";
let work = "";
let brokenHome = "";
let liveHome = "";
let resumeHome = "";
let fake: { readonly port: number; stop(): void } | null = null;

const makeHome = async (config: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "ye-headless-"));
    await mkdir(join(dir, ".ye"), { recursive: true });
    await writeFile(join(dir, ".ye", "config.json"), config);
    return dir;
};

beforeAll(async () => {
    home = await makeHome(JSON.stringify(CONFIG));
    work = join(home, "work");
    await mkdir(work, { recursive: true });
    brokenHome = await makeHome(JSON.stringify({ defaultProvider: 7 }));
    fake = startFakeOllama();
    const liveConfig = JSON.stringify({
        ...CONFIG,
        providers: {
            ollama: { baseUrl: `http://127.0.0.1:${fake.port}`, apiKeyEnv: "OLLAMA_API_KEY" },
        },
    });
    liveHome = await makeHome(liveConfig);
    resumeHome = await makeHome(liveConfig);
});

afterAll(async () => {
    fake?.stop();
    await rm(home, { recursive: true, force: true });
    await rm(brokenHome, { recursive: true, force: true });
    await rm(liveHome, { recursive: true, force: true });
    await rm(resumeHome, { recursive: true, force: true });
});

const run = async (
    args: readonly string[],
    opts: { readonly stdin?: string; readonly home?: string } = {},
): Promise<RunResult> => {
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
        cwd: work,
        env: { ...process.env, HOME: opts.home ?? home, NO_COLOR: "1" },
        stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { code, stdout, stderr };
};

const SUMMARY_KEYS = [
    "ok",
    "result",
    "stopReason",
    "sessionId",
    "projectId",
    "model",
    "provider",
    "turns",
    "usage",
    "durationMs",
];

describe("piped stdout is not truncated by process.exit", () => {
    test("--help reaches its final line through a pipe", async () => {
        const res = await run(["--help"]);
        expect(res.code).toBe(0);
        expect(res.stdout).toContain("-h, --help");
        expect(res.stdout).toContain("-v, --version");
        expect(res.stdout.trimEnd().endsWith("as events happen.")).toBe(true);
        expect(res.stdout.length).toBeGreaterThan(600);
    });

    test("--version prints only the bare version", async () => {
        const res = await run(["--version"]);
        expect(res.code).toBe(0);
        expect(res.stdout).toBe(`${CURRENT_VERSION}\n`);
    });
});

describe("headless output formats", () => {
    test(
        "text mode keeps stdout free of structured output",
        async () => {
            const res = await run(["-p", "hi"]);
            expect(res.code).toBe(1);
            expect(res.stdout).toBe("\n");
            expect(res.stderr).toContain("ye:");
        },
        { timeout: 60_000 },
    );

    test(
        "json mode writes exactly one object and nothing else",
        async () => {
            const res = await run(["--output-format", "json", "-p", "hi"]);
            expect(res.code).toBe(1);
            const lines = res.stdout.split("\n").filter((l) => l.length > 0);
            expect(lines).toHaveLength(1);
            const summary = JSON.parse(lines[0] as string) as Record<string, unknown>;
            for (const key of SUMMARY_KEYS) expect(summary).toHaveProperty(key);
            expect(summary["ok"]).toBe(false);
            expect(summary["provider"]).toBe("ollama");
            expect(summary["model"]).toBe("e2e-test-model");
            expect(typeof summary["error"]).toBe("string");
            expect(typeof summary["sessionId"]).toBe("string");
            expect(typeof summary["durationMs"]).toBe("number");
            expect(summary["usage"]).toEqual({
                inputTokens: 0,
                outputTokens: 0,
                cachedTokens: 0,
                costUsd: 0,
            });
        },
        { timeout: 60_000 },
    );

    test(
        "stream-json lines all parse and end with the summary",
        async () => {
            const res = await run(["--output-format", "stream-json", "-p", "hi"]);
            expect(res.code).toBe(1);
            const lines = res.stdout.split("\n").filter((l) => l.length > 0);
            expect(lines.length).toBeGreaterThan(1);
            const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
            for (const line of parsed) expect(typeof line["type"]).toBe("string");
            const types = parsed.map((l) => l["type"]);
            expect(types).toContain("turn.start");
            expect(types).toContain("turn.end");
            const last = parsed[parsed.length - 1] as Record<string, unknown>;
            expect(last["type"]).toBe("result");
            expect(last["ok"]).toBe(false);
            for (const key of SUMMARY_KEYS) expect(last).toHaveProperty(key);
        },
        { timeout: 60_000 },
    );

    test(
        "a config failure still yields a parseable object and a non-zero exit",
        async () => {
            const res = await run(["--output-format", "json", "-p", "hi"], { home: brokenHome });
            expect(res.code).toBe(1);
            const summary = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
            expect(summary["ok"]).toBe(false);
            expect(summary["stopReason"]).toBe("error");
            expect(typeof summary["error"]).toBe("string");
        },
        { timeout: 60_000 },
    );

    test(
        "an invalid --output-format value exits non-zero without touching stdout",
        async () => {
            const res = await run(["--output-format", "yaml", "-p", "hi"]);
            expect(res.code).toBe(1);
            expect(res.stdout).toBe("");
            expect(res.stderr).toContain('invalid --output-format "yaml"');
        },
        { timeout: 60_000 },
    );
});

describe("headless output formats on a successful run", () => {
    test(
        "text mode streams only the model text plus the trailing newline",
        async () => {
            const res = await run(["-p", "hi"], { home: liveHome });
            expect(res.code).toBe(0);
            expect(res.stdout).toBe(`${REPLY.join("")}\n`);
            expect(res.stderr).not.toContain("ye:");
        },
        { timeout: 60_000 },
    );

    test(
        "json mode reports the final assistant text and the session usage",
        async () => {
            const res = await run(["--output-format", "json", "-p", "hi"], { home: liveHome });
            expect(res.code).toBe(0);
            const lines = res.stdout.split("\n").filter((l) => l.length > 0);
            expect(lines).toHaveLength(1);
            const summary = JSON.parse(lines[0] as string) as Record<string, unknown>;
            expect(summary["ok"]).toBe(true);
            expect(summary["result"]).toBe(REPLY.join(""));
            expect(summary["stopReason"]).toBe("end_turn");
            expect(summary["turns"]).toBe(1);
            expect(summary).not.toHaveProperty("error");
            const usage = summary["usage"] as Record<string, number>;
            expect(usage["inputTokens"]).toBeGreaterThanOrEqual(11);
            expect(usage["outputTokens"]).toBeGreaterThanOrEqual(5);
        },
        { timeout: 60_000 },
    );

    test(
        "stream-json mode emits the text deltas before the summary",
        async () => {
            const res = await run(["--output-format", "stream-json", "-p", "hi"], {
                home: liveHome,
            });
            expect(res.code).toBe(0);
            const parsed = res.stdout
                .split("\n")
                .filter((l) => l.length > 0)
                .map((l) => JSON.parse(l) as Record<string, unknown>);
            const deltas = parsed
                .filter((l) => l["type"] === "model.text")
                .map((l) => l["delta"] as string);
            expect(deltas.join("")).toBe(REPLY.join(""));
            const last = parsed[parsed.length - 1] as Record<string, unknown>;
            expect(last["type"]).toBe("result");
            expect(last["ok"]).toBe(true);
            expect(last["result"]).toBe(REPLY.join(""));
        },
        { timeout: 60_000 },
    );
});

describe("headless stdin", () => {
    test(
        "a piped prompt is read from stdin and used for the turn",
        async () => {
            const res = await run(["--output-format", "json"], { stdin: "fix the build\n" });
            expect(res.code).toBe(1);
            const summary = JSON.parse(res.stdout.trim()) as Record<string, string>;
            const transcript = await readFile(
                join(
                    home,
                    ".ye",
                    "projects",
                    summary["projectId"] as string,
                    "sessions",
                    `${summary["sessionId"] as string}.jsonl`,
                ),
                "utf8",
            );
            expect(transcript).toContain("fix the build");
        },
        { timeout: 60_000 },
    );

    test(
        "empty stdin is an error, not a hang",
        async () => {
            const res = await run(["--output-format", "json"], { stdin: "" });
            expect(res.code).toBe(1);
            expect(res.stderr).toContain("no prompt on stdin");
            const summary = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
            expect(summary["ok"]).toBe(false);
        },
        { timeout: 60_000 },
    );
});

const summaryOf = (res: RunResult): Record<string, unknown> =>
    JSON.parse(res.stdout.split("\n").filter((l) => l.length > 0)[0] as string) as Record<
        string,
        unknown
    >;

const transcriptOf = async (homeDir: string, summary: Record<string, unknown>): Promise<string> =>
    readFile(
        join(
            homeDir,
            ".ye",
            "projects",
            summary["projectId"] as string,
            "sessions",
            `${summary["sessionId"] as string}.jsonl`,
        ),
        "utf8",
    );

describe("headless resume", () => {
    test(
        "--continue appends to the most recent session and replays its history",
        async () => {
            const first = summaryOf(
                await run(["--output-format", "json", "-p", "first prompt"], {
                    home: resumeHome,
                }),
            );
            expect(first["ok"]).toBe(true);

            const second = summaryOf(
                await run(["--output-format", "json", "--continue", "-p", "second prompt"], {
                    home: resumeHome,
                }),
            );
            expect(second["ok"]).toBe(true);
            expect(second["sessionId"]).toBe(first["sessionId"] as string);

            const sent = lastChatMessages.map((m) => m.content ?? "").join("\n");
            expect(sent).toContain("first prompt");
            expect(sent).toContain(REPLY.join(""));
            expect(sent).toContain("second prompt");

            const transcript = await transcriptOf(resumeHome, second);
            expect(transcript).toContain("first prompt");
            expect(transcript).toContain("second prompt");
        },
        { timeout: 60_000 },
    );

    test(
        "--resume <id> continues that exact session",
        async () => {
            const first = summaryOf(
                await run(["--output-format", "json", "-p", "named resume base"], {
                    home: resumeHome,
                }),
            );
            const sessionId = first["sessionId"] as string;
            const second = summaryOf(
                await run(
                    ["--output-format", "json", "--resume", sessionId, "-p", "named resume next"],
                    { home: resumeHome },
                ),
            );
            expect(second["sessionId"]).toBe(sessionId);
            const transcript = await transcriptOf(resumeHome, second);
            expect(transcript).toContain("named resume base");
            expect(transcript).toContain("named resume next");
        },
        { timeout: 60_000 },
    );

    test(
        "--resume with an unknown id errors instead of starting fresh",
        async () => {
            const res = await run(
                ["--output-format", "json", "--resume", "no-such-session", "-p", "hi"],
                { home: resumeHome },
            );
            expect(res.code).toBe(1);
            expect(res.stderr).toContain("session not found: no-such-session");
            const summary = summaryOf(res);
            expect(summary["ok"]).toBe(false);
            expect(summary["sessionId"]).toBe("");
        },
        { timeout: 60_000 },
    );

    test(
        "--continue with no prior session errors instead of starting fresh",
        async () => {
            const emptyHome = await makeHome(JSON.stringify(CONFIG));
            try {
                const res = await run(["--output-format", "json", "--continue", "-p", "hi"], {
                    home: emptyHome,
                });
                expect(res.code).toBe(1);
                expect(res.stderr).toContain("no previous session to resume");
                expect(summaryOf(res)["ok"]).toBe(false);
            } finally {
                await rm(emptyHome, { recursive: true, force: true });
            }
        },
        { timeout: 60_000 },
    );

    test(
        "--continue and --resume together exit before anything runs",
        async () => {
            const res = await run(["--continue", "--resume", "-p", "hi"], { home: resumeHome });
            expect(res.code).toBe(1);
            expect(res.stdout).toBe("");
            expect(res.stderr).toContain("mutually exclusive");
        },
        { timeout: 60_000 },
    );
});

describe("model and provider overrides", () => {
    test(
        "--model and --provider are reported for the run",
        async () => {
            const res = await run([
                "--output-format",
                "json",
                "--provider",
                "ollama",
                "--model",
                "override-model",
                "-p",
                "hi",
            ]);
            const summary = summaryOf(res);
            expect(summary["provider"]).toBe("ollama");
            expect(summary["model"]).toBe("override-model");
        },
        { timeout: 60_000 },
    );

    test(
        "an override is never written back to config.json",
        async () => {
            const before = await readFile(join(home, ".ye", "config.json"), "utf8");
            await run(["--output-format", "json", "--model", "override-model", "-p", "hi"]);
            expect(await readFile(join(home, ".ye", "config.json"), "utf8")).toBe(before);
        },
        { timeout: 60_000 },
    );

    test(
        "an unknown provider exits before the pipeline with the valid ids",
        async () => {
            const res = await run(["--output-format", "json", "--provider", "gemini", "-p", "hi"]);
            expect(res.code).toBe(1);
            expect(res.stdout).toBe("");
            expect(res.stderr).toContain('unknown provider "gemini"');
            expect(res.stderr).toContain("openrouter");
        },
        { timeout: 60_000 },
    );
});
