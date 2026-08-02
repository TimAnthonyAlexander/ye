const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CR = 13;
const LF = 10;
const SEPARATOR_LENGTH = 4;

export const encodeFrame = (payload: unknown): Uint8Array => {
    const body = encoder.encode(JSON.stringify(payload));
    const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
    const frame = new Uint8Array(header.byteLength + body.byteLength);
    frame.set(header, 0);
    frame.set(body, header.byteLength);
    return frame;
};

const indexOfSeparator = (buffer: Uint8Array): number => {
    for (let i = 0; i + SEPARATOR_LENGTH <= buffer.byteLength; i++) {
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

const contentLength = (header: string): number | undefined => {
    for (const line of header.split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
        const value = Number.parseInt(line.slice(colon + 1).trim(), 10);
        return Number.isNaN(value) ? undefined : value;
    }
    return undefined;
};

// A single read from a language server's stdout carries anything from half a
// header to several whole frames, so bytes accumulate here until a frame is
// complete. Content-Length counts BYTES, which is why this buffers Uint8Array
// rather than decoded text.
export class FrameBuffer {
    private buffer = new Uint8Array(0);

    append(chunk: Uint8Array): void {
        const next = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
        next.set(this.buffer, 0);
        next.set(chunk, this.buffer.byteLength);
        this.buffer = next;
    }

    next(): unknown | undefined {
        const separator = indexOfSeparator(this.buffer);
        if (separator < 0) return undefined;

        const bodyStart = separator + SEPARATOR_LENGTH;
        const length = contentLength(decoder.decode(this.buffer.subarray(0, separator)));
        if (length === undefined) {
            this.buffer = this.buffer.slice(bodyStart);
            return this.next();
        }
        if (this.buffer.byteLength < bodyStart + length) return undefined;

        const body = decoder.decode(this.buffer.subarray(bodyStart, bodyStart + length));
        this.buffer = this.buffer.slice(bodyStart + length);
        const parsed: unknown = JSON.parse(body);
        return parsed;
    }

    drain(): readonly unknown[] {
        const messages: unknown[] = [];
        for (;;) {
            const message = this.next();
            if (message === undefined) return messages;
            messages.push(message);
        }
    }
}
