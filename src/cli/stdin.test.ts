import { describe, expect, test } from "bun:test";
import { readStdinPrompt, STDIN_MAX_BYTES } from "./stdin.ts";

const streamOf = (...chunks: readonly string[]): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i >= chunks.length) {
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(chunks[i]));
            i += 1;
        },
    });
};

describe("readStdinPrompt", () => {
    test("reads the whole stream and trims trailing newline", async () => {
        const read = await readStdinPrompt(streamOf("fix the build\n"));
        expect(read).toEqual({ ok: true, text: "fix the build" });
    });

    test("joins chunks split mid-character", async () => {
        const encoder = new TextEncoder();
        const bytes = encoder.encode("héllo — ok");
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes.slice(0, 2));
                controller.enqueue(bytes.slice(2));
                controller.close();
            },
        });
        const read = await readStdinPrompt(stream);
        expect(read).toEqual({ ok: true, text: "héllo — ok" });
    });

    test("empty stream yields empty text", async () => {
        expect(await readStdinPrompt(streamOf())).toEqual({ ok: true, text: "" });
    });

    test("rejects input past the cap", async () => {
        const read = await readStdinPrompt(streamOf("a".repeat(11), "b"), 10);
        expect(read.ok).toBe(false);
        if (read.ok) throw new Error("expected failure");
        expect(read.error).toContain("limit");
    });

    test("the default cap is 10MB", async () => {
        expect(STDIN_MAX_BYTES).toBe(10 * 1024 * 1024);
        const oversize = "x".repeat(1024 * 1024);
        const chunks = Array.from({ length: 11 }, () => oversize);
        const read = await readStdinPrompt(streamOf(...chunks));
        expect(read.ok).toBe(false);
        if (read.ok) throw new Error("expected failure");
        expect(read.error).toBe("stdin prompt is larger than the 10MB limit");
    });

    test("input exactly at the cap is accepted", async () => {
        const read = await readStdinPrompt(streamOf("abcde"), 5);
        expect(read).toEqual({ ok: true, text: "abcde" });
    });
});
