// NDJSON line iterator. Yields each newline-delimited JSON line as a string.
// Ollama streams /api/chat and /api/generate as raw newline-separated JSON
// objects (no `data:` SSE prefix), terminated by a chunk with `"done": true`.

export async function* ndjsonLines(response: Response): AsyncGenerator<string> {
    if (!response.body) {
        throw new Error("response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let nl = buffer.indexOf("\n");
            while (nl !== -1) {
                const raw = buffer.slice(0, nl);
                const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
                buffer = buffer.slice(nl + 1);
                if (line.length > 0) yield line;
                nl = buffer.indexOf("\n");
            }
        }
        const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
        if (tail.length > 0) yield tail;
    } finally {
        reader.releaseLock();
    }
}
