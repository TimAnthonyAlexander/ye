// SSE line iterator. Yields the data payload string of each `data:` event.
// Skips comment lines (start with `:`) and the OpenAI-compatible `[DONE]` terminator.

export async function* sseDataLines(response: Response): AsyncGenerator<string> {
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

        if (line.length === 0 || line.startsWith(":")) {
          nl = buffer.indexOf("\n");
          continue;
        }
        if (line.startsWith("data:")) {
          const data = line.slice(5).trimStart();
          if (data === "[DONE]") return;
          yield data;
        }
        nl = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
