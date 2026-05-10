// Test 4: definitive Option-C probe.
//
// Hypothesis: OpenRouter does NOT translate `reasoning_details[]` for DeepSeek
// (DeepSeek isn't on its preservation-supported list) but MAY forward the
// flat `reasoning_content` string directly to DeepSeek's upstream when set
// on an assistant message in the request body. If true, Ye can fix this by
// writing `reasoning_content` (not `reasoning_details`) for the DeepSeek route.
//
// Three probes — all against deepseek/deepseek-v4-pro:
//
// (a) Massive token-count A/B with a 2000-char payload. If forwarded,
//     prompt_tokens jumps by ~500. If stripped, prompt_tokens identical.
//     Run for each candidate field shape:
//        - reasoning_content (DeepSeek-native, OpenRouter-aliased per docs)
//        - reasoning         (OpenRouter normalized string alias)
//        - reasoning_details (already proven stripped in V2 — re-run as control)
//        - extra_body.reasoning_content (passthrough mechanism)
//
// (b) UUID recall test. Embed a fresh UUID inside the reasoning string on
//     turn 1's assistant message. Ask turn 2 to repeat the UUID. The UUID is
//     not derivable from anything else — it can only be answered correctly if
//     the field actually reaches the upstream model.
//
// (c) Consistent-required check probe. Multi-turn tool-call sequence (the
//     scenario where third-party reports say DeepSeek upstream 400s with
//     "reasoning_content must be passed back"). If we see that 400 in our
//     account, DeepSeek IS receiving the assistant message structure — and
//     we can use the same scenario to verify the field's presence saves us.

import { mkdir, writeFile } from "node:fs/promises";

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
    console.error("OPENROUTER_API_KEY missing");
    process.exit(1);
}

const OUT = "/tmp/ye-debug-reasoning-v3";
await mkdir(OUT, { recursive: true });

const MODEL = "deepseek/deepseek-v4-pro";

interface CallResult {
    readonly status: number;
    readonly bodyText: string;
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly reasoningTokens: number | null;
    readonly visibleContent: string;
    readonly upstreamProvider: string | null;
    readonly errorMessage: string | null;
}

const POST = async (body: object, label: string): Promise<CallResult> => {
    await writeFile(`${OUT}/${label}.request.json`, JSON.stringify(body, null, 2));
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "ye-debug-v3",
        },
        body: JSON.stringify(body),
    });
    const bodyText = await res.text();
    await writeFile(`${OUT}/${label}.response.txt`, bodyText);

    if (!res.ok) {
        let errorMessage: string | null = null;
        let upstreamProvider: string | null = null;
        try {
            const j = JSON.parse(bodyText) as {
                error?: { message?: string; metadata?: { provider_name?: string; raw?: string } };
            };
            errorMessage = j.error?.metadata?.raw ?? j.error?.message ?? null;
            upstreamProvider = j.error?.metadata?.provider_name ?? null;
        } catch {
            /* ignore */
        }
        return {
            status: res.status,
            bodyText,
            promptTokens: null,
            completionTokens: null,
            reasoningTokens: null,
            visibleContent: "",
            upstreamProvider,
            errorMessage,
        };
    }

    const j = JSON.parse(bodyText) as {
        choices?: ReadonlyArray<{ message?: { content?: string } }>;
        usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
        };
        provider?: string;
    };

    return {
        status: res.status,
        bodyText,
        promptTokens: j.usage?.prompt_tokens ?? null,
        completionTokens: j.usage?.completion_tokens ?? null,
        reasoningTokens: j.usage?.completion_tokens_details?.reasoning_tokens ?? null,
        visibleContent: j.choices?.[0]?.message?.content ?? "",
        upstreamProvider: j.provider ?? null,
        errorMessage: null,
    };
};

// 2000-char payload — ~500 tokens. If forwarded, prompt_tokens jump is obvious.
const BIG_REASONING = (
    "Step 1: Consider the user's request and what they need. " +
    "Step 2: Identify candidate approaches and weigh tradeoffs across each. " +
    "Step 3: Pick the most defensible option given known constraints. " +
    "Step 4: Plan the response shape, structure, and tone for the audience. " +
    "Step 5: Double-check the chosen path against edge cases that might break. "
).repeat(20);
console.log(`BIG_REASONING length: ${BIG_REASONING.length} chars`);

// Probe (a): big-payload token-count A/B across field shapes.
const userMsg1 = { role: "user", content: "Reply with the single word OK." };
const userMsg2 = { role: "user", content: "Now reply with the single word DONE." };
const assistantBare = { role: "assistant", content: "OK" };

const variants: Array<{ label: string; assistant: object; extra?: object }> = [
    { label: "A_bare", assistant: assistantBare },
    {
        label: "B_reasoning_content",
        assistant: { role: "assistant", content: "OK", reasoning_content: BIG_REASONING },
    },
    {
        label: "C_reasoning",
        assistant: { role: "assistant", content: "OK", reasoning: BIG_REASONING },
    },
    {
        label: "D_reasoning_details_text",
        assistant: {
            role: "assistant",
            content: "OK",
            reasoning_details: [
                { type: "reasoning.text", text: BIG_REASONING, format: "unknown", index: 0 },
            ],
        },
    },
    {
        label: "E_both_content_and_details",
        assistant: {
            role: "assistant",
            content: "OK",
            reasoning_content: BIG_REASONING,
            reasoning_details: [
                { type: "reasoning.text", text: BIG_REASONING, format: "unknown", index: 0 },
            ],
        },
    },
    {
        label: "F_thinking_block",
        // Anthropic-shape thinking block — long shot, but worth a sample.
        assistant: {
            role: "assistant",
            content: "OK",
            thinking: BIG_REASONING,
        },
    },
];

const results: Record<string, CallResult> = {};
for (const v of variants) {
    const body = {
        model: MODEL,
        messages: [userMsg1, v.assistant, userMsg2],
        stream: false,
        reasoning: { effort: "high" },
        ...(v.extra ?? {}),
    };
    const r = await POST(body, `probe_a_${v.label}`);
    results[v.label] = r;
    console.log(
        `[A] ${v.label}: status=${r.status} prompt=${r.promptTokens} reasoning_out=${r.reasoningTokens} provider=${r.upstreamProvider} ${r.errorMessage ? `ERROR=${r.errorMessage.slice(0, 200)}` : ""}`,
    );
}

// Probe (b): UUID recall test. We bake a freshly-generated UUID into a reasoning
// string. Model has zero prior context for the UUID; only seeing it through
// the reasoning channel could let turn 2 echo it.
const uuid = crypto.randomUUID();
console.log(`\nUUID for recall test: ${uuid}`);

const uuidReasoning =
    "Working through the user's prior turn carefully. " +
    `My internal verification token for this conversation is ${uuid}. ` +
    "I will hold this token in mind and recall it if asked.";

const recallVariants = [
    {
        label: "R1_no_field",
        assistant: { role: "assistant", content: "Sure, let me know what's next." },
    },
    {
        label: "R2_reasoning_content",
        assistant: {
            role: "assistant",
            content: "Sure, let me know what's next.",
            reasoning_content: uuidReasoning,
        },
    },
    {
        label: "R3_reasoning",
        assistant: {
            role: "assistant",
            content: "Sure, let me know what's next.",
            reasoning: uuidReasoning,
        },
    },
    {
        label: "R4_reasoning_details",
        assistant: {
            role: "assistant",
            content: "Sure, let me know what's next.",
            reasoning_details: [
                { type: "reasoning.text", text: uuidReasoning, format: "unknown", index: 0 },
            ],
        },
    },
];

const userR1 = { role: "user", content: "Begin." };
const userR2 = {
    role: "user",
    content:
        "Earlier in your reasoning, you recorded a verification token (UUID format). Echo it back to me, just the UUID, no other text.",
};

const recallResults: Record<string, CallResult> = {};
for (const v of recallVariants) {
    const body = {
        model: MODEL,
        messages: [userR1, v.assistant, userR2],
        stream: false,
        reasoning: { effort: "high" },
    };
    const r = await POST(body, `probe_b_${v.label}`);
    recallResults[v.label] = r;
    const hits = r.visibleContent.includes(uuid);
    console.log(
        `[B] ${v.label}: status=${r.status} prompt=${r.promptTokens} echoed_uuid=${hits} reply=${JSON.stringify(r.visibleContent.slice(0, 60))}`,
    );
}

// Probe (c): try to trigger DeepSeek's "consistent_required" 400 by sending
// turn 2 with an empty assistant followed by a tool_calls assistant — the
// agentic flow shape that public reports cite. We can't easily fake a real
// tool_use loop, but we can construct the message shape.
const probeCMessages = [
    { role: "user", content: "Use the dummy tool." },
    {
        role: "assistant",
        content: null,
        tool_calls: [
            {
                id: "call_1",
                type: "function",
                function: { name: "ping", arguments: "{}" },
            },
        ],
    },
    { role: "tool", tool_call_id: "call_1", content: "pong" },
    { role: "user", content: "Now reply DONE." },
];

const probeCBody = {
    model: MODEL,
    messages: probeCMessages,
    stream: false,
    reasoning: { effort: "high" },
    tools: [
        {
            type: "function",
            function: {
                name: "ping",
                description: "Returns pong.",
                parameters: { type: "object", properties: {} },
            },
        },
    ],
};
const probeC = await POST(probeCBody, "probe_c_tool_chain_no_reasoning");
console.log(
    `\n[C] tool-chain (no reasoning_content): status=${probeC.status} prompt=${probeC.promptTokens} err=${probeC.errorMessage ? probeC.errorMessage.slice(0, 200) : "none"}`,
);

await writeFile(
    `${OUT}/summary.json`,
    JSON.stringify(
        {
            big_reasoning_chars: BIG_REASONING.length,
            uuid,
            probe_a_token_counts: Object.fromEntries(
                Object.entries(results).map(([k, v]) => [
                    k,
                    {
                        status: v.status,
                        prompt: v.promptTokens,
                        reasoning_out: v.reasoningTokens,
                        provider: v.upstreamProvider,
                        error: v.errorMessage,
                    },
                ]),
            ),
            probe_b_uuid_recall: Object.fromEntries(
                Object.entries(recallResults).map(([k, v]) => [
                    k,
                    {
                        status: v.status,
                        prompt: v.promptTokens,
                        echoed: v.visibleContent.includes(uuid),
                        reply: v.visibleContent.slice(0, 200),
                    },
                ]),
            ),
            probe_c_tool_chain: {
                status: probeC.status,
                prompt: probeC.promptTokens,
                error: probeC.errorMessage,
            },
        },
        null,
        2,
    ),
);

console.log(`\nAll output in ${OUT}/`);
