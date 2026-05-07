import { sseDataLines } from "../sse.ts";
import type { ProviderEvent, StopReason } from "../types.ts";

interface ToolCallAccumulator {
    id?: string;
    name?: string;
    args: string;
}

interface ChunkChoiceDelta {
    role?: string;
    content?: string;
    tool_calls?: ReadonlyArray<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
    }>;
}

interface ChunkChoice {
    index?: number;
    delta?: ChunkChoiceDelta;
    finish_reason?: string | null;
}

interface ChunkPayload {
    choices?: ReadonlyArray<ChunkChoice>;
    error?: { message?: string; code?: number };
}

const mapFinishReason = (raw: string | null | undefined): StopReason => {
    switch (raw) {
        case "stop":
            return "end_turn";
        case "tool_calls":
            return "tool_use";
        case "length":
            return "max_tokens";
        case "error":
        case "content_filter":
            return "error";
        default:
            return "end_turn";
    }
};

const safeParseJson = (raw: string): ChunkPayload | null => {
    try {
        return JSON.parse(raw) as ChunkPayload;
    } catch {
        return null;
    }
};

export async function* parseStream(response: Response): AsyncGenerator<ProviderEvent> {
    const toolCalls = new Map<number, ToolCallAccumulator>();
    let stopReason: StopReason = "end_turn";
    let errorMessage: string | undefined;

    for await (const data of sseDataLines(response)) {
        const chunk = safeParseJson(data);
        if (!chunk) continue;

        if (chunk.error) {
            stopReason = "error";
            errorMessage = chunk.error.message ?? "unknown provider error";
            break;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};

        if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "text.delta", text: delta.content };
        }

        if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const acc = toolCalls.get(idx) ?? { args: "" };
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (typeof tc.function?.arguments === "string") {
                    acc.args += tc.function.arguments;
                }
                toolCalls.set(idx, acc);
            }
        }

        if (choice.finish_reason) {
            stopReason = mapFinishReason(choice.finish_reason);
        }
    }

    if (stopReason === "tool_use") {
        for (const acc of toolCalls.values()) {
            if (!acc.id || !acc.name) continue;
            let args: unknown;
            try {
                args = JSON.parse(acc.args.length > 0 ? acc.args : "{}");
            } catch {
                args = { _raw: acc.args };
            }
            yield { type: "tool_call", id: acc.id, name: acc.name, args };
        }
    }

    yield errorMessage !== undefined
        ? { type: "stop", reason: stopReason, error: errorMessage }
        : { type: "stop", reason: stopReason };
}
