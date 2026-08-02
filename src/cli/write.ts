import { writeSync } from "node:fs";

// process.stdout.write is asynchronous when stdout is a pipe, and process.exit
// discards whatever is still queued — piping `ye --help` truncated it at the
// 512-byte pipe boundary. Anything written immediately before an exit has to go
// out synchronously.
const writeAll = (fd: number, text: string): void => {
    const buf = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < buf.length) {
        try {
            offset += writeSync(fd, buf, offset, buf.length - offset);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "EAGAIN") continue;
            if (code === "EPIPE") return;
            throw err;
        }
    }
};

export const writeOut = (text: string): void => writeAll(1, text);

export const writeErr = (text: string): void => writeAll(2, text);
