export const STDIN_MAX_BYTES = 10 * 1024 * 1024;

export type StdinPromptResult =
    | { readonly ok: true; readonly text: string }
    | { readonly ok: false; readonly error: string };

// Reads the whole stream itself rather than going through process.stdin:
// patch-stdin.ts rewrites process.stdin.read() for Ink's key decoding, and a
// piped prompt must not travel through that path.
export const readStdinPrompt = async (
    stream: ReadableStream<Uint8Array>,
    maxBytes: number = STDIN_MAX_BYTES,
): Promise<StdinPromptResult> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === undefined) continue;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                return {
                    ok: false,
                    error: `stdin prompt is larger than the ${Math.round(maxBytes / (1024 * 1024))}MB limit`,
                };
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { ok: true, text: new TextDecoder().decode(merged).trim() };
};
