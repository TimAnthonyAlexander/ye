import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameBuffer } from "./protocol.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

describe("LSP framing", () => {
    test("F1 encodeFrame writes a Content-Length header and a blank-line separator", () => {
        const payload = { jsonrpc: "2.0", id: 1, method: "initialize" };
        const text = decoder.decode(encodeFrame(payload));
        const separator = text.indexOf("\r\n\r\n");

        expect(separator).toBeGreaterThan(0);
        const body = text.slice(separator + 4);
        expect(text.slice(0, separator)).toBe(`Content-Length: ${encoder.encode(body).byteLength}`);
        expect(JSON.parse(body)).toEqual(payload);
    });

    test("F2 round-trips a payload through the buffer", () => {
        const payload = { jsonrpc: "2.0", id: 7, result: { ok: true } };
        const buffer = new FrameBuffer();
        buffer.append(encodeFrame(payload));
        expect(buffer.next()).toEqual(payload);
        expect(buffer.next()).toBeUndefined();
    });

    test("F3 a frame split across many reads reassembles", () => {
        const payload = { jsonrpc: "2.0", id: 2, result: [1, 2, 3] };
        const bytes = encodeFrame(payload);
        const buffer = new FrameBuffer();

        for (let i = 0; i < bytes.byteLength - 1; i++) {
            buffer.append(bytes.subarray(i, i + 1));
            expect(buffer.next()).toBeUndefined();
        }
        buffer.append(bytes.subarray(bytes.byteLength - 1));
        expect(buffer.next()).toEqual(payload);
    });

    test("F4 a split at the header/body boundary reassembles", () => {
        const payload = { jsonrpc: "2.0", id: 3, result: null };
        const bytes = encodeFrame(payload);
        const boundary = decoder.decode(bytes).indexOf("\r\n\r\n") + 4;
        const buffer = new FrameBuffer();

        buffer.append(bytes.subarray(0, boundary));
        expect(buffer.next()).toBeUndefined();
        buffer.append(bytes.subarray(boundary));
        expect(buffer.next()).toEqual(payload);
    });

    test("F5 several frames in one read all drain, in order", () => {
        const first = { jsonrpc: "2.0", id: 1, result: "a" };
        const second = { jsonrpc: "2.0", method: "window/logMessage" };
        const third = { jsonrpc: "2.0", id: 2, result: "c" };
        const bytes = [first, second, third].map(encodeFrame);
        const merged = new Uint8Array(bytes.reduce((n, b) => n + b.byteLength, 0));
        let offset = 0;
        for (const chunk of bytes) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
        }

        const buffer = new FrameBuffer();
        buffer.append(merged);
        expect(buffer.drain()).toEqual([first, second, third]);
    });

    test("F6 Content-Length counts bytes, not characters", () => {
        const payload = { jsonrpc: "2.0", id: 4, result: "héllo — ✓ 日本語" };
        const bytes = encodeFrame(payload);
        const buffer = new FrameBuffer();

        buffer.append(bytes.subarray(0, bytes.byteLength - 3));
        expect(buffer.next()).toBeUndefined();
        buffer.append(bytes.subarray(bytes.byteLength - 3));
        expect(buffer.next()).toEqual(payload);
    });

    test("F7 trailing bytes of a second frame survive the first frame's parse", () => {
        const first = { jsonrpc: "2.0", id: 1, result: "a" };
        const second = { jsonrpc: "2.0", id: 2, result: "b" };
        const secondBytes = encodeFrame(second);
        const buffer = new FrameBuffer();

        buffer.append(encodeFrame(first));
        buffer.append(secondBytes.subarray(0, 5));
        expect(buffer.next()).toEqual(first);
        expect(buffer.next()).toBeUndefined();
        buffer.append(secondBytes.subarray(5));
        expect(buffer.next()).toEqual(second);
    });
});
