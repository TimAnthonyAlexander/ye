import type { Message } from "../../providers/index.ts";

// Cheap heuristic: ~4 chars per token on the JSON-serialized message list.
// Good enough for shaper triggers; the model's own tokenizer is the source of
// truth at request time. Provider-supplied countTokens() can replace this once
// available for a given provider.
export const estimateTokens = (messages: readonly Message[]): number =>
    Math.ceil(JSON.stringify(messages).length / 4);
