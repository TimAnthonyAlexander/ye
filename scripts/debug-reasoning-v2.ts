// V2 of the reasoning round-trip probe. Fixes:
//   - Forces visible reply to be a single fixed token ("READY") so the number
//     cannot leak via content. We retry turn 1 up to 5 times until the model
//     complies (no digits in visible content).
//   - Routes the same calls through Ye's actual OpenRouter provider parser as
//     well, to verify that our `parseStream` captures `delta.reasoning_details`
//     when OpenRouter emits them.
//
// Output: /tmp/ye-debug-reasoning-v2/

import { mkdir, writeFile } from "node:fs/promises";
import { parseStream } from "../src/providers/openrouter/stream.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
    console.error("OPENROUTER_API_KEY missing");
    process.exit(1);
}

const OUT_DIR = "/tmp/ye-debug-reasoning-v2";
await mkdir(OUT_DIR, { recursive: true });

const MODEL = "deepseek/deepseek-v4-pro";

const POST = async (body: object): Promise<Response> =>
    fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "ye-debug-v2",
        },
        body: JSON.stringify(body),
    });

// Probe A: capture raw SSE + dump field usage per chunk.
const captureRaw = async (
    messages: readonly object[],
    label: string,
): Promise<{
    rawSse: string;
    reasoningPlain: string;
    structuredDetails: object[];
    visibleContent: string;
    fields: {
        reasoning: number;
        reasoning_content: number;
        reasoning_details: number;
    };
    usage: unknown;
}> => {
    const body = {
        model: MODEL,
        messages,
        stream: true,
        reasoning: { effort: "high" },
    };
    await writeFile(`${OUT_DIR}/${label}.request.json`, JSON.stringify(body, null, 2));
    const res = await POST(body);
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${await res.text()}`);
    let raw = "";
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += dec.decode(value, { stream: true });
    }
    raw += dec.decode();
    await writeFile(`${OUT_DIR}/${label}.raw.sse`, raw);

    let reasoningPlain = "";
    let visibleContent = "";
    const structuredDetails: object[] = [];
    let usage: unknown = null;
    const fields = { reasoning: 0, reasoning_content: 0, reasoning_details: 0 };
    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data: ")) continue;
        const data = t.slice(6);
        if (data === "[DONE]") continue;
        let chunk: {
            choices?: ReadonlyArray<{
                delta?: {
                    content?: string;
                    reasoning?: string;
                    reasoning_content?: string;
                    reasoning_details?: ReadonlyArray<object>;
                };
            }>;
            usage?: unknown;
        };
        try {
            chunk = JSON.parse(data);
        } catch {
            continue;
        }
        if (chunk.usage) usage = chunk.usage;
        const d = chunk.choices?.[0]?.delta ?? {};
        if (typeof d.reasoning === "string") {
            fields.reasoning++;
            reasoningPlain += d.reasoning;
        }
        if (typeof d.reasoning_content === "string") {
            fields.reasoning_content++;
            reasoningPlain += d.reasoning_content;
        }
        if (Array.isArray(d.reasoning_details)) {
            fields.reasoning_details++;
            for (const x of d.reasoning_details) structuredDetails.push(x);
        }
        if (typeof d.content === "string") visibleContent += d.content;
    }
    return { rawSse: raw, reasoningPlain, structuredDetails, visibleContent, fields, usage };
};

// Probe B: feed the same raw SSE through Ye's parseStream and count what it
// emits. Verifies our parser actually consumes `delta.reasoning_details`.
const captureViaYeParser = async (
    label: string,
    raw: string,
): Promise<{
    reasoningDeltas: number;
    reasoningCompleteCount: number;
    reasoningCompleteDetails: readonly object[];
    textDeltas: number;
}> => {
    const synthResponse = new Response(raw, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
    let reasoningDeltas = 0;
    let reasoningCompleteCount = 0;
    let reasoningCompleteDetails: readonly object[] = [];
    let textDeltas = 0;
    for await (const evt of parseStream(synthResponse) as AsyncIterable<ProviderEvent>) {
        if (evt.type === "reasoning.delta") reasoningDeltas++;
        else if (evt.type === "reasoning.complete") {
            reasoningCompleteCount++;
            reasoningCompleteDetails = evt.details;
        } else if (evt.type === "text.delta") textDeltas++;
    }
    const report = {
        label,
        reasoningDeltas,
        reasoningCompleteCount,
        reasoningCompleteDetailsCount: reasoningCompleteDetails.length,
        textDeltas,
        firstDetail: reasoningCompleteDetails[0] ?? null,
    };
    await writeFile(`${OUT_DIR}/${label}.ye-parser-report.json`, JSON.stringify(report, null, 2));
    return { reasoningDeltas, reasoningCompleteCount, reasoningCompleteDetails, textDeltas };
};

const containsDigit = (s: string): boolean => /\d/.test(s);

// --- TURN 1: pick a number, commit it in reasoning, visible reply must be
// exactly "READY" with no digits. Retry until compliant.
const turn1Prompt = {
    role: "user",
    content:
        "Pick any number between 1 and 100 (your choice). Inside your reasoning, write the number as a numeral (e.g. '47'). Your visible reply must be EXACTLY the single word READY — no digits, no number, no other words. If you say anything other than READY in the visible reply you fail the task.",
};

let turn1: Awaited<ReturnType<typeof captureRaw>> | null = null;
for (let attempt = 1; attempt <= 5; attempt++) {
    const cap = await captureRaw([turn1Prompt], `turn1.attempt${attempt}`);
    console.log(
        `turn1 attempt ${attempt}: visible=${JSON.stringify(cap.visibleContent.slice(0, 50))} fields=${JSON.stringify(cap.fields)}`,
    );
    if (!containsDigit(cap.visibleContent) && cap.reasoningPlain.match(/\b\d{1,3}\b/)) {
        turn1 = cap;
        break;
    }
}
if (!turn1) {
    console.error("Could not get clean turn 1 (model leaked number into visible content).");
    process.exit(2);
}

// Verify Ye's parser sees the same structure
const yeT1 = await captureViaYeParser("turn1.ye-parser", turn1.rawSse);
console.log("Ye parser on turn 1:", yeT1);

const numbersInReasoning = (turn1.reasoningPlain.match(/\b\d{1,3}\b/g) ?? []) as string[];
console.log("\nTurn 1 numbers found in reasoning:", numbersInReasoning);
console.log("Turn 1 visible content:", JSON.stringify(turn1.visibleContent));
const pickedNumber = numbersInReasoning[0]!;

await writeFile(
    `${OUT_DIR}/turn1.summary.json`,
    JSON.stringify(
        {
            pickedNumber,
            visibleContent: turn1.visibleContent,
            reasoningPlain: turn1.reasoningPlain,
            structuredDetailsLen: turn1.structuredDetails.length,
            firstStructuredDetail: turn1.structuredDetails[0] ?? null,
            fields: turn1.fields,
            yeParser: yeT1,
        },
        null,
        2,
    ),
);

// --- TURN 2 VARIANTS ---
const turn2UserMsg = {
    role: "user",
    content:
        "What number did you pick? Look back at your own reasoning from the prior turn. Answer with ONLY the numeral, nothing else.",
};

const variants: Array<{
    label: string;
    assistant: object;
}> = [
    {
        label: "turn2a_bare",
        assistant: { role: "assistant", content: turn1.visibleContent },
    },
    {
        label: "turn2b_reasoning_details",
        assistant: {
            role: "assistant",
            content: turn1.visibleContent,
            reasoning_details: turn1.structuredDetails,
        },
    },
    {
        label: "turn2c_reasoning_content_string",
        assistant: {
            role: "assistant",
            content: turn1.visibleContent,
            reasoning_content: turn1.reasoningPlain,
        },
    },
    {
        label: "turn2d_reasoning_string",
        assistant: {
            role: "assistant",
            content: turn1.visibleContent,
            reasoning: turn1.reasoningPlain,
        },
    },
];

const summary: Record<string, unknown> = {
    pickedNumber,
    turn1Fields: turn1.fields,
    yeParserTurn1: yeT1,
    variants: {},
};

for (const v of variants) {
    const cap = await captureRaw([turn1Prompt, v.assistant, turn2UserMsg], v.label);
    const reply = cap.visibleContent.trim();
    const correct = reply.includes(pickedNumber);
    console.log(
        `\n${v.label}: visible=${JSON.stringify(reply)} | picked=${pickedNumber} | correct=${correct}`,
    );
    console.log(
        `  fields=${JSON.stringify(cap.fields)} | reasoning_len=${cap.reasoningPlain.length}`,
    );
    (summary.variants as Record<string, unknown>)[v.label] = {
        visibleReply: reply,
        correct,
        fields: cap.fields,
        reasoningLen: cap.reasoningPlain.length,
        reasoningSnippet: cap.reasoningPlain.slice(0, 600),
    };
}

await writeFile(`${OUT_DIR}/summary.json`, JSON.stringify(summary, null, 2));
console.log(`\n=== FINAL SUMMARY ===`);
console.log(JSON.stringify(summary, null, 2));
console.log(`\nAll output in ${OUT_DIR}/`);
