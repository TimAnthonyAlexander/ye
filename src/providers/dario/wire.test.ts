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
    body: { model?: string; messages?: unknown[]; stream?: boolean };
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
