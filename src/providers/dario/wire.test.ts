import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Config } from "../../config/index.ts";
import { DEFAULT_CONFIG } from "../../config/defaults.ts";
import type { ProviderEvent } from "../types.ts";
import { buildDarioFromConfig } from "./index.ts";

// dario speaks the standard Anthropic Messages API on the client side — that is
// the whole reason this provider reuses the anthropic adapter and stream parser
// verbatim. This test pins that assumption against a server that mimics it.

const SSE = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0,"cache_read_input_tokens":7}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"reading the file"}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":23}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
].join("\n\n");

interface Captured {
    path: string;
    apiKey: string | null;
    version: string | null;
    userAgent: string | null;
    body: {
        model?: string;
        messages?: unknown[];
        stream?: boolean;
        system?: { type: string; text: string }[];
        tools?: { name: string }[];
    };
}

let server: ReturnType<typeof Bun.serve>;
let captured: Captured;

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        fetch: async (req) => {
            const url = new URL(req.url);
            captured = {
                path: url.pathname,
                apiKey: req.headers.get("x-api-key"),
                version: req.headers.get("anthropic-version"),
                userAgent: req.headers.get("user-agent"),
                body: (await req.json()) as Captured["body"],
            };
            return new Response(SSE, {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });
});

afterAll(() => server.stop(true));

const configAt = (baseUrl: string): Config => ({
    ...DEFAULT_CONFIG,
    providers: {
        ...DEFAULT_CONFIG.providers,
        dario: { baseUrl, apiKeyEnv: "DARIO_API_KEY" },
    },
});

describe("dario wire compatibility", () => {
    test("posts a standard Messages request and parses the standard stream", async () => {
        const provider = buildDarioFromConfig(configAt(server.url.origin));
        const events: ProviderEvent[] = [];
        for await (const event of provider.stream({
            model: "claude-opus-4-8",
            messages: [{ role: "user", content: "read a.ts" }],
            tools: [],
            maxTokens: 1024,
        })) {
            events.push(event);
        }

        expect(captured.path).toBe("/v1/messages");
        expect(captured.apiKey).toBe("dario");
        expect(captured.version).toBe("2023-06-01");
        expect(captured.body.model).toBe("claude-opus-4-8");
        expect(captured.body.messages).toBeArray();
        expect(captured.body.stream).toBe(true);

        expect(events.map((e) => e.type)).toEqual([
            "text.delta",
            "tool_call.starting",
            "tool_call",
            "usage",
            "stop",
        ]);
        const call = events.find((e) => e.type === "tool_call");
        expect(call).toMatchObject({ id: "toolu_1", name: "Read", args: { path: "a.ts" } });
        const usage = events.find((e) => e.type === "usage");
        expect(usage).toMatchObject({
            usage: { inputTokens: 11, outputTokens: 23, cacheReadTokens: 7 },
        });
        expect(events.at(-1)).toMatchObject({ type: "stop", reason: "tool_use" });
    });

    // dario deletes `<system-reminder>` blocks from every outbound request, so
    // a reminder that leaves Ye under that name never reaches the model — and a
    // message that was only a reminder reaches Anthropic as an empty text block
    // carrying Ye's cache breakpoint, which is a non-retryable 400.
    test("no system-reminder tag survives to the wire", async () => {
        const provider = buildDarioFromConfig(configAt(server.url.origin));
        for await (const _ of provider.stream({
            model: "claude-opus-4-8",
            messages: [
                { role: "user", content: "go" },
                { role: "assistant", content: "waiting on the build" },
                { role: "user", content: "<system-reminder>Nothing is running.</system-reminder>" },
            ],
            tools: [],
            maxTokens: 16,
        })) {
            // drain
        }

        const wire = JSON.stringify(captured.body);
        expect(wire).not.toContain("system-reminder");
        // The text itself still has to arrive — renaming the tag, not dropping it.
        expect(wire).toContain("Nothing is running.");
        expect(wire).toContain("system-note");
    });

    // dario replaces the tool array with Claude Code's unless the request is
    // shaped like a CC one: system must be an array of 2+ blocks, block 0
    // carrying the billing-header marker and block 1 naming the Claude Agent
    // SDK. Miss it and the model never sees Ye's schemas — it sees CC's, and
    // answers Read(file_path), AskUserQuestion(questions), TodoWrite(string).
    test("the request carries dario's passthrough discriminator", async () => {
        const provider = buildDarioFromConfig(configAt(server.url.origin));
        for await (const _ of provider.stream({
            model: "claude-opus-4-8",
            messages: [
                { role: "system", content: "You are Ye." },
                { role: "user", content: "go" },
            ],
            tools: [{ name: "Read", description: "read a file", parameters: { type: "object" } }],
            maxTokens: 16,
        })) {
            // drain
        }

        const system = captured.body.system ?? [];
        expect(system.length).toBe(3);
        expect(system[0]?.text).toContain("x-anthropic-billing-header:");
        expect(system[1]?.text).toContain("Claude Agent SDK");
        expect(system[2]?.text).toBe("You are Ye.");
        // Ye's own tools, unremapped — the point of the whole exercise.
        expect(captured.body.tools?.map((t) => t.name)).toEqual(["Read"]);
        // Blank, so dario forwards its own captured Claude Code user-agent
        // rather than Bun's default.
        expect(captured.userAgent).toBe("");
    });

    test("a configured key overrides the placeholder", async () => {
        const cfg = configAt(server.url.origin);
        const provider = buildDarioFromConfig({
            ...cfg,
            providers: {
                ...cfg.providers,
                dario: { ...cfg.providers["dario"]!, apiKey: "shared-secret" },
            },
        });
        for await (const _ of provider.stream({
            model: "claude-opus-4-8",
            messages: [{ role: "user", content: "hi" }],
            tools: [],
            maxTokens: 16,
        })) {
            // drain
        }
        expect(captured.apiKey).toBe("shared-secret");
    });
});
