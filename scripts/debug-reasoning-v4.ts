// V4: per-upstream-provider check. Same UUID recall test, but pinned to each
// known V4 Pro upstream so we know which ones actually forward
// reasoning_content. Required output: for each provider, prompt_tokens jumps
// and the model echoes the UUID iff forwarding works.

import { writeFile } from "node:fs/promises";

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
    console.error("OPENROUTER_API_KEY missing");
    process.exit(1);
}

const OUT = "/tmp/ye-debug-reasoning-v4";
await Bun.write(`${OUT}/_init`, "");
const MODEL = "deepseek/deepseek-v4-pro";

// Providers OpenRouter has been observed routing V4 Pro to across the v3 run.
const PROVIDERS = ["DeepSeek", "DeepInfra", "Novita", "GMICloud"];

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
    uuid: string,
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
            "X-OpenRouter-Title": "ye-debug-v4",
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
            error: text.slice(0, 400),
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

console.log("Per-provider UUID recall test for deepseek/deepseek-v4-pro\n");
console.log(
    `${"provider".padEnd(12)} ${"baseline".padEnd(10)} ${"with_rc".padEnd(10)} echo_uuid uuid_echoed`,
);

const matrix: Record<string, unknown> = {};
for (const p of PROVIDERS) {
    const uuid = crypto.randomUUID();
    const reasoning = `Working through this carefully. My verification token for this conversation is ${uuid}. I will hold this token in mind and recall it if asked.`;

    const baseline = await POST(p, null, uuid, `${p}_baseline`);
    const withRc = await POST(p, reasoning, uuid, `${p}_with_rc`);

    const uuidEchoed = withRc.visibleContent.includes(uuid);
    const baseEchoed = baseline.visibleContent.includes(uuid);
    matrix[p] = {
        baseline: {
            status: baseline.status,
            prompt: baseline.promptTokens,
            upstream: baseline.upstream,
            echoed: baseEchoed,
            error: baseline.error,
        },
        with_reasoning_content: {
            status: withRc.status,
            prompt: withRc.promptTokens,
            upstream: withRc.upstream,
            echoed: uuidEchoed,
            reply: withRc.visibleContent.slice(0, 80),
            error: withRc.error,
        },
        verdict: withRc.error
            ? "error"
            : uuidEchoed
              ? "FORWARDS reasoning_content"
              : baseEchoed
                ? "noise (baseline also echoed??)"
                : "STRIPS reasoning_content",
    };
    console.log(
        `${p.padEnd(12)} ${String(baseline.promptTokens).padEnd(10)} ${String(withRc.promptTokens).padEnd(10)} ${String(uuidEchoed).padEnd(9)} ${uuid}  ${withRc.error ? "ERR: " + withRc.error.slice(0, 60) : ""}`,
    );
}

await writeFile(`${OUT}/summary.json`, JSON.stringify(matrix, null, 2));
console.log(`\nMatrix written to ${OUT}/summary.json`);
console.log(JSON.stringify(matrix, null, 2));
