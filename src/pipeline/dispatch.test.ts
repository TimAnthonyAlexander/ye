import { describe, expect, test } from "bun:test";
import { streamFromProvider, type ModelStreamResult } from "./dispatch.ts";
import type { Event } from "./events.ts";
import type { Provider, ProviderEvent, ProviderInput } from "../providers/index.ts";

const input = (over: Partial<ProviderInput> = {}): ProviderInput => ({
    model: "m",
    messages: [],
    signal: new AbortController().signal,
    ...over,
});

const drain = async (
    gen: AsyncGenerator<Event, ModelStreamResult>,
): Promise<{ events: Event[]; result: ModelStreamResult }> => {
    const events: Event[] = [];
    while (true) {
        const n = await gen.next();
        if (n.done) return { events, result: n.value };
        events.push(n.value);
    }
};

// Yields nothing and only settles when its (derived) signal aborts — models a
// stream stuck with the connection open but no bytes, no close, no error.
const stallingProvider = (): Provider =>
    ({
        id: "fake",
        async *stream(inp: ProviderInput): AsyncGenerator<ProviderEvent> {
            await new Promise<void>((resolve) => {
                inp.signal?.addEventListener("abort", () => resolve());
            });
        },
    }) as unknown as Provider;

describe("streamFromProvider stall handling", () => {
    test("a stalled stream surfaces a retryable stream_error within the timeout", async () => {
        const gen = streamFromProvider(stallingProvider(), input(), undefined, 30);
        const { events, result } = await drain(gen);
        expect(events).toHaveLength(0);
        expect(result.stopReason).toBe("error");
        expect(result.error?.kind).toBe("stream_error");
        expect(result.error?.retryable).toBe(true);
    });

    test("a normal stream is unaffected by the stall guard", async () => {
        const provider = {
            id: "fake",
            async *stream(): AsyncGenerator<ProviderEvent> {
                yield { type: "text.delta", text: "hi" } as ProviderEvent;
                yield { type: "stop", reason: "end_turn" } as ProviderEvent;
            },
        } as unknown as Provider;
        const { result } = await drain(streamFromProvider(provider, input(), undefined, 30));
        expect(result.stopReason).toBe("end_turn");
        expect(result.text).toBe("hi");
    });
});
