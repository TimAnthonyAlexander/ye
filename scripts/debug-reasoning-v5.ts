// V5: full provider matrix. Test reasoning_content forwarding for every
// upstream OpenRouter lists for deepseek/deepseek-v4-pro, with 8-second
// spacing between requests to dodge rate limits. Identify the 1M-context
// providers that also forward reasoning_content — those are pin candidates.

import { writeFile } from "node:fs/promises";

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
    console.error("OPENROUTER_API_KEY missing");
    process.exit(1);
}

const OUT = "/tmp/ye-debug-reasoning-v5";
await Bun.write(`${OUT}/_init`, "");

const MODEL = "deepseek/deepseek-v4-pro";

// Skipping Together (512k) and Venice (most expensive cached-tier). Keeping
// every 1M-context provider at the lower price tier.
const PROVIDERS = [
    "DeepSeek",
    "GMICloud",
    "AtlasCloud",
    "Novita",
    "SiliconFlow",
    "Parasail",
    "DeepInfra",
];

interface CallResult {
    status: number;
    promptTokens: number | null;
    visibleContent: string;
    upstream: string | null;
    error: string | null;
}

const POST = async (
    provider: string,
    reasoningContent: string | null,
    label: string,
): Promise<CallResult> => {
    const assistant: Record<string, unknown> = {
        role: "assistant",
        content: "Sure, let me know what's next.",
    };
    if (reasoningContent !== null) assistant["reasoning_content"] = reasoningContent;

    const body = {
        model: MODEL,
        messages: [
            { role: "user", content: "Begin." },
            assistant,
            {
                role: "user",
                content:
                    "Earlier in your reasoning, you recorded a verification token (UUID format). Echo it back to me, just the UUID, no other text.",
            },
        ],
        stream: false,
        reasoning: { effort: "high" },
        provider: { order: [provider], allow_fallbacks: false },
    };
    await writeFile(`${OUT}/${label}.request.json`, JSON.stringify(body, null, 2));

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "ye-debug-v5",
        },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    await writeFile(`${OUT}/${label}.response.txt`, text);

    if (!res.ok) {
        return {
            status: res.status,
            promptTokens: null,
            visibleContent: "",
            upstream: provider,
            error: text.slice(0, 500),
        };
    }
    const j = JSON.parse(text) as {
        provider?: string;
        usage?: { prompt_tokens?: number };
        choices?: ReadonlyArray<{ message?: { content?: string } }>;
    };
    return {
        status: res.status,
        promptTokens: j.usage?.prompt_tokens ?? null,
        visibleContent: j.choices?.[0]?.message?.content ?? "",
        upstream: j.provider ?? null,
        error: null,
    };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`Per-provider reasoning_content forwarding test for ${MODEL}`);
console.log("8s spacing between requests to dodge rate limits.\n");
console.log(
    `${"provider".padEnd(13)} ${"baseline".padEnd(9)} ${"with_rc".padEnd(9)} echoed  verdict`,
);
console.log("-".repeat(80));

const matrix: Record<string, unknown> = {};
for (const p of PROVIDERS) {
    const uuid = crypto.randomUUID();
    const reasoning = `Working through this carefully. My verification token for this conversation is ${uuid}. I will hold this token in mind and recall it if asked.`;

    const baseline = await POST(p, null, `${p}_baseline`);
    await sleep(8000);
    const withRc = await POST(p, reasoning, `${p}_with_rc`);
    await sleep(8000);

    const echoed = withRc.visibleContent.includes(uuid);
    const baseEchoed = baseline.visibleContent.includes(uuid);

    const verdict = withRc.error
        ? `ERR ${withRc.status}`
        : baseline.error
          ? `BASELINE ERR ${baseline.status}`
          : baseEchoed
            ? "noise"
            : echoed
              ? "FORWARDS ✅"
              : "STRIPS ❌";

    matrix[p] = {
        baseline: {
            status: baseline.status,
            prompt: baseline.promptTokens,
            upstream: baseline.upstream,
            echoed: baseEchoed,
            error: baseline.error?.slice(0, 200) ?? null,
        },
        with_reasoning_content: {
            status: withRc.status,
            prompt: withRc.promptTokens,
            upstream: withRc.upstream,
            echoed,
            reply: withRc.visibleContent.slice(0, 80),
            error: withRc.error?.slice(0, 200) ?? null,
        },
        verdict,
    };

    console.log(
        `${p.padEnd(13)} ${String(baseline.promptTokens ?? "—").padEnd(9)} ${String(withRc.promptTokens ?? "—").padEnd(9)} ${String(echoed).padEnd(7)} ${verdict}`,
    );
}

await writeFile(`${OUT}/summary.json`, JSON.stringify(matrix, null, 2));
console.log(`\nMatrix written to ${OUT}/summary.json`);
