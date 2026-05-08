// End-to-end probe of OpenRouter against the actual tool pool we send in
// production. Run with:
//   OPENROUTER_API_KEY=… bun scripts/debug-openrouter.ts
// Override the target model with DEBUG_MODEL=…

import { listTools } from "../src/tools/registry.ts";

const KEY = process.env["OPENROUTER_API_KEY"];
if (!KEY) {
    console.error("OPENROUTER_API_KEY not set");
    process.exit(1);
}

const URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env["DEBUG_MODEL"] ?? "~google/gemini-flash-latest";

const ms = (n: number) => `${(n / 1000).toFixed(2)}s`;

const tools = listTools().map((t) => ({
    type: "function" as const,
    function: {
        name: t.name,
        description: t.description,
        parameters: t.schema,
    },
}));

console.log(`Loaded ${tools.length} tools, target model: ${MODEL}`);

interface ProbeResult {
    httpStatus: number;
    timeToHeaders: number;
    timeToFirstChunk: number | null;
    timeToFirstReasoning: number | null;
    timeToFirstContent: number | null;
    timeToDone: number;
    chunkCount: number;
    reasoningCharCount: number;
    contentCharCount: number;
    finishReason: string | null;
    chunkError: unknown;
    rawHttpBody?: string;
    deltaKeysSeen: string[];
    sampleChunks: string[];
}

async function streamProbe(
    label: string,
    messages: unknown[],
    opts: {
        readonly reasoning?: unknown;
        readonly includeTools?: boolean;
    } = {},
): Promise<ProbeResult> {
    const reasoning = opts.reasoning ?? { effort: "high" };
    const includeTools = opts.includeTools ?? true;

    console.log(`\n=== ${label} ===`);
    console.log(`  reasoning=${JSON.stringify(reasoning)}, tools=${includeTools}`);

    const body: Record<string, unknown> = {
        model: MODEL,
        messages,
        stream: true,
    };
    if (reasoning !== false) body["reasoning"] = reasoning;
    if (includeTools) {
        body["tools"] = tools;
        body["parallel_tool_calls"] = false;
    }

    const t0 = Date.now();
    const ctl = new AbortController();
    const timeoutId = setTimeout(() => ctl.abort(), 180_000);

    let res: Response;
    try {
        res = await fetch(URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${KEY}`,
                "Content-Type": "application/json",
                "X-OpenRouter-Title": "Ye-Debug",
            },
            body: JSON.stringify(body),
            signal: ctl.signal,
        });
    } catch (e) {
        clearTimeout(timeoutId);
        console.error(`  network failure after ${ms(Date.now() - t0)}:`, e);
        throw e;
    }

    const result: ProbeResult = {
        httpStatus: res.status,
        timeToHeaders: Date.now() - t0,
        timeToFirstChunk: null,
        timeToFirstReasoning: null,
        timeToFirstContent: null,
        timeToDone: 0,
        chunkCount: 0,
        reasoningCharCount: 0,
        contentCharCount: 0,
        finishReason: null,
        chunkError: null,
        deltaKeysSeen: [],
        sampleChunks: [],
    };

    console.log(`  HTTP ${res.status} headers in ${ms(result.timeToHeaders)}`);

    if (!res.ok) {
        result.rawHttpBody = await res.text().catch(() => "");
        clearTimeout(timeoutId);
        console.error(`  HTTP body (full):`, result.rawHttpBody);
        return result;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const seenKeys = new Set<string>();
    let toolCallEmitted = false;
    let toolCallName: string | null = null;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line.length === 0) continue;
            if (line.startsWith(":")) continue;
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]" || data.length === 0) continue;

            const tNow = Date.now();
            if (result.timeToFirstChunk === null) {
                result.timeToFirstChunk = tNow - t0;
                console.log(`  first chunk in ${ms(result.timeToFirstChunk)}`);
            }

            let chunk: any;
            try {
                chunk = JSON.parse(data);
            } catch {
                console.warn("  parse failure on chunk:", data.slice(0, 200));
                continue;
            }
            result.chunkCount++;

            if (result.sampleChunks.length < 3) {
                result.sampleChunks.push(JSON.stringify(chunk));
            }

            if (chunk.error) {
                result.chunkError = chunk.error;
                console.error("  MID-STREAM ERROR:", JSON.stringify(chunk.error, null, 2));
            }

            const choice = chunk.choices?.[0];
            const delta = choice?.delta;
            if (delta && typeof delta === "object") {
                for (const k of Object.keys(delta)) seenKeys.add(k);
            }
            if (typeof delta?.content === "string" && delta.content.length > 0) {
                if (result.timeToFirstContent === null) {
                    result.timeToFirstContent = tNow - t0;
                    console.log(`  first content in ${ms(result.timeToFirstContent)}`);
                }
                result.contentCharCount += delta.content.length;
            }
            const reasoningDelta = delta?.reasoning ?? delta?.reasoning_content;
            if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
                if (result.timeToFirstReasoning === null) {
                    result.timeToFirstReasoning = tNow - t0;
                    console.log(`  first reasoning in ${ms(result.timeToFirstReasoning)}`);
                }
                result.reasoningCharCount += reasoningDelta.length;
            }
            if (Array.isArray(delta?.tool_calls)) {
                for (const tc of delta.tool_calls) {
                    if (tc.function?.name && !toolCallEmitted) {
                        toolCallName = tc.function.name;
                        toolCallEmitted = true;
                        console.log(`  tool_call: ${toolCallName}`);
                    }
                }
            }
            if (choice?.finish_reason) result.finishReason = choice.finish_reason;
        }
    }

    clearTimeout(timeoutId);
    result.timeToDone = Date.now() - t0;
    result.deltaKeysSeen = [...seenKeys];

    console.log(
        `  → done in ${ms(result.timeToDone)} | chunks=${result.chunkCount} content=${result.contentCharCount}ch reasoning=${result.reasoningCharCount}ch finish=${result.finishReason}`,
    );
    console.log(`  delta keys seen: [${result.deltaKeysSeen.join(", ")}]`);
    return result;
}

(async () => {
    // 1. Plain greeting with the real tool pool. This is the call that errored
    //    400 on schema validation. Should now succeed.
    await streamProbe("Probe 1: 'hi wassup' with full tool pool", [
        { role: "user", content: "hi wassup" },
    ]);

    // 2. A prompt that should trigger TodoWrite — exercises the array-of-object
    //    schema we just fixed. If Gemini accepts the items declaration the
    //    response will include a tool_call rather than 400ing.
    await streamProbe("Probe 2: prompt that should call TodoWrite", [
        {
            role: "user",
            content:
                "Plan a 3-step refactor. Use the TodoWrite tool with three pending todos: 'extract foo', 'add bar', 'remove baz'.",
        },
    ]);

    // 3. AskUserQuestion exerciser — array of objects with label/description.
    await streamProbe("Probe 3: prompt that should call AskUserQuestion", [
        {
            role: "user",
            content:
                "Use AskUserQuestion to ask me whether to use TypeScript or JavaScript, with a brief description for each.",
        },
    ]);

    // 4. WebSearch exerciser — array of strings (allowed_domains).
    await streamProbe("Probe 4: prompt that should call WebSearch with domain filter", [
        {
            role: "user",
            content:
                "Use WebSearch to look up 'site reliability engineering' and restrict allowed_domains to ['google.com', 'wikipedia.org'].",
        },
    ]);

    // 5. Reasoning probe — does Gemini Flash stream reasoning at all?
    await streamProbe(
        "Probe 5: reasoning streaming check (no tools)",
        [
            {
                role: "user",
                content: "How many r's are in 'strawberry'? Think step by step before answering.",
            },
        ],
        { includeTools: false, reasoning: { effort: "high" } },
    );
})();
