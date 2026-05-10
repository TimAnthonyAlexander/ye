// Debug script: prove exactly which reasoning fields OpenRouter returns for
// deepseek/deepseek-v4-pro, and whether sending them back affects turn 2.
//
// Three probes:
//   1. Turn 1: send "pick a number, commit it explicitly in your reasoning".
//      Dump every SSE chunk's reasoning-related fields. Reassemble plain text
//      vs structured details. Save the raw stream for grep-friendly inspection.
//   2. Turn 2A: send turn 1's assistant message back WITHOUT reasoning_details.
//      Ask "what number did you pick?". Capture the reasoning + visible reply.
//   3. Turn 2B: send turn 1's assistant message back WITH reasoning_details (or
//      synthesized text if upstream gave plain text). Ask the same question.
//      Capture and compare.
//
// Run: OPENROUTER_API_KEY=... bun run scripts/debug-reasoning.ts
// Output: /tmp/ye-debug-reasoning/*.{txt,json}

import { mkdir, writeFile } from "node:fs/promises";

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
    console.error("OPENROUTER_API_KEY missing");
    process.exit(1);
}

const OUT_DIR = "/tmp/ye-debug-reasoning";
await mkdir(OUT_DIR, { recursive: true });

const MODEL = "deepseek/deepseek-v4-pro";

interface ChunkSummary {
    readonly idx: number;
    readonly hasReasoning: boolean;
    readonly hasReasoningContent: boolean;
    readonly hasReasoningDetails: boolean;
    readonly reasoningDetailsLen: number;
    readonly contentDelta: string | null;
    readonly finishReason: string | null;
}

interface CapturedTurn {
    readonly rawSse: string;
    readonly chunkSummaries: readonly ChunkSummary[];
    readonly reassembledReasoningPlain: string;
    readonly reassembledContent: string;
    readonly structuredDetails: readonly unknown[];
    readonly fieldUsage: {
        readonly reasoning_count: number;
        readonly reasoning_content_count: number;
        readonly reasoning_details_count: number;
    };
    readonly usage: unknown;
    readonly raw_x_openrouter_headers: Record<string, string>;
}

const callOpenRouter = async (
    messages: readonly object[],
    label: string,
): Promise<CapturedTurn> => {
    const body = {
        model: MODEL,
        messages,
        stream: true,
        reasoning: { effort: "high" },
    };
    await writeFile(`${OUT_DIR}/${label}.request.json`, JSON.stringify(body, null, 2));

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "ye-debug",
        },
        body: JSON.stringify(body),
    });

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
        if (k.toLowerCase().includes("openrouter") || k.toLowerCase() === "x-request-id") {
            headers[k] = v;
        }
    });

    if (!res.ok) {
        const text = await res.text();
        console.error(`[${label}] HTTP ${res.status}: ${text}`);
        throw new Error(`OpenRouter ${res.status}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();

    await writeFile(`${OUT_DIR}/${label}.raw.sse`, raw);

    const chunkSummaries: ChunkSummary[] = [];
    let reassembledReasoningPlain = "";
    let reassembledContent = "";
    const structuredDetails: unknown[] = [];
    let fieldUsage = {
        reasoning_count: 0,
        reasoning_content_count: 0,
        reasoning_details_count: 0,
    };
    let usage: unknown = null;
    let idx = 0;
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        let chunk: {
            choices?: ReadonlyArray<{
                delta?: {
                    content?: string;
                    reasoning?: string;
                    reasoning_content?: string;
                    reasoning_details?: ReadonlyArray<object>;
                };
                finish_reason?: string | null;
            }>;
            usage?: unknown;
        };
        try {
            chunk = JSON.parse(data);
        } catch {
            continue;
        }
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta ?? {};
        const summary: ChunkSummary = {
            idx,
            hasReasoning: typeof delta.reasoning === "string",
            hasReasoningContent: typeof delta.reasoning_content === "string",
            hasReasoningDetails: Array.isArray(delta.reasoning_details),
            reasoningDetailsLen: Array.isArray(delta.reasoning_details)
                ? delta.reasoning_details.length
                : 0,
            contentDelta: typeof delta.content === "string" ? delta.content : null,
            finishReason: chunk.choices?.[0]?.finish_reason ?? null,
        };
        chunkSummaries.push(summary);
        idx++;

        if (typeof delta.reasoning === "string") {
            fieldUsage.reasoning_count++;
            reassembledReasoningPlain += delta.reasoning;
        }
        if (typeof delta.reasoning_content === "string") {
            fieldUsage.reasoning_content_count++;
            reassembledReasoningPlain += delta.reasoning_content;
        }
        if (Array.isArray(delta.reasoning_details)) {
            fieldUsage.reasoning_details_count++;
            for (const d of delta.reasoning_details) structuredDetails.push(d);
        }
        if (typeof delta.content === "string") reassembledContent += delta.content;
    }

    return {
        rawSse: raw,
        chunkSummaries,
        reassembledReasoningPlain,
        reassembledContent,
        structuredDetails,
        fieldUsage,
        usage,
        raw_x_openrouter_headers: headers,
    };
};

const dumpReport = async (label: string, t: CapturedTurn) => {
    const report = {
        label,
        fieldUsage: t.fieldUsage,
        totalChunks: t.chunkSummaries.length,
        reasoningLen: t.reassembledReasoningPlain.length,
        contentLen: t.reassembledContent.length,
        structuredDetailsCount: t.structuredDetails.length,
        structuredDetailsSample: t.structuredDetails.slice(0, 2),
        firstChunkWithReasoning: t.chunkSummaries.find(
            (c) => c.hasReasoning || c.hasReasoningContent || c.hasReasoningDetails,
        ),
        usage: t.usage,
        headers: t.raw_x_openrouter_headers,
        reassembledReasoning: t.reassembledReasoningPlain,
        reassembledContent: t.reassembledContent,
    };
    await writeFile(`${OUT_DIR}/${label}.report.json`, JSON.stringify(report, null, 2));
    console.log(`\n=== ${label} ===`);
    console.log(`chunks total          : ${t.chunkSummaries.length}`);
    console.log(`fields used           :`, t.fieldUsage);
    console.log(`reasoning plain (len) : ${t.reassembledReasoningPlain.length}`);
    console.log(`structured details    : ${t.structuredDetails.length}`);
    if (t.structuredDetails.length > 0) {
        console.log(`first detail          :`, t.structuredDetails[0]);
    }
    console.log(`visible content       : ${JSON.stringify(t.reassembledContent.slice(0, 200))}`);
    console.log(`usage                 :`, t.usage);
};

// --- PROBE 1: turn 1 ---
const turn1Messages = [
    {
        role: "user",
        content:
            "Pick a number between 1 and 100. Write the exact number as a numeral inside your reasoning (e.g. write '47'). Do NOT mention the number in your visible reply — only say 'ready'.",
    },
];

const turn1 = await callOpenRouter(turn1Messages, "turn1");
await dumpReport("turn1", turn1);

// --- PROBE 2A: turn 2 WITHOUT reasoning_details ---
const turn2aMessages = [
    ...turn1Messages,
    { role: "assistant", content: turn1.reassembledContent },
    {
        role: "user",
        content:
            "What number did you pick? Look back at your own reasoning from the prior turn — answer with the exact numeral.",
    },
];
const turn2a = await callOpenRouter(turn2aMessages, "turn2a_no_reasoning");
await dumpReport("turn2a_no_reasoning", turn2a);

// --- PROBE 2B: turn 2 WITH reasoning_details (structured if available; else
// synthesized from plain-text reasoning) ---
const synthesizedDetails =
    turn1.structuredDetails.length > 0
        ? turn1.structuredDetails
        : [
              {
                  type: "reasoning.text",
                  text: turn1.reassembledReasoningPlain,
                  format: "unknown",
                  index: 0,
              },
          ];
const turn2bMessages = [
    ...turn1Messages,
    {
        role: "assistant",
        content: turn1.reassembledContent,
        reasoning_details: synthesizedDetails,
    },
    {
        role: "user",
        content:
            "What number did you pick? Look back at your own reasoning from the prior turn — answer with the exact numeral.",
    },
];
const turn2b = await callOpenRouter(turn2bMessages, "turn2b_with_reasoning_details");
await dumpReport("turn2b_with_reasoning_details", turn2b);

// --- PROBE 2C: turn 2 WITH reasoning_content (DeepSeek-native field) on the
// assistant message, as a fallback if reasoning_details isn't honored by
// the OpenRouter→DeepSeek translator ---
const turn2cMessages = [
    ...turn1Messages,
    {
        role: "assistant",
        content: turn1.reassembledContent,
        reasoning_content: turn1.reassembledReasoningPlain,
    },
    {
        role: "user",
        content:
            "What number did you pick? Look back at your own reasoning from the prior turn — answer with the exact numeral.",
    },
];
const turn2c = await callOpenRouter(turn2cMessages, "turn2c_with_reasoning_content");
await dumpReport("turn2c_with_reasoning_content", turn2c);

console.log(`\nAll output written to ${OUT_DIR}/`);
console.log(
    `Compare turn2a vs turn2b vs turn2c visible content to see which (if any) carries the number.`,
);
