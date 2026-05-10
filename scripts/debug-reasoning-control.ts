// Control test: does OpenRouter forward reasoning_details for models on its
// support list? Compare prompt_tokens on a turn-2 request with vs without the
// field, for both deepseek/deepseek-v4-pro and anthropic/claude-sonnet-4.6
// (the latter IS on OpenRouter's "reasoning preservation supported" list).
//
// Same assistant content and same user messages — the only delta is the
// presence of `reasoning_details` on the assistant. If OpenRouter forwards,
// prompt_tokens jumps. If it strips, prompt_tokens is identical.

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
    console.error("OPENROUTER_API_KEY missing");
    process.exit(1);
}

const POST = async (body: object): Promise<Response> =>
    fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "ye-debug-control",
        },
        body: JSON.stringify(body),
    });

const fakeReasoning =
    "Step 1: Consider what the user is asking. They want a sample answer. " +
    "Step 2: I'll think about a few different angles before committing. " +
    "Step 3: A good answer is concise but thoughtful. Let me pick a path. " +
    "Step 4: Done — I'll go with option X.";

const fakeDetails = [
    {
        type: "reasoning.text",
        text: fakeReasoning,
        format: "unknown",
        index: 0,
    },
];

const userMsg1 = { role: "user", content: "Say 'hi'." };
const assistantNoDetails = { role: "assistant", content: "hi" };
const assistantWithDetails = {
    role: "assistant",
    content: "hi",
    reasoning_details: fakeDetails,
};
const userMsg2 = { role: "user", content: "Now say 'bye'." };

const run = async (model: string): Promise<void> => {
    console.log(`\n=== Model: ${model} ===`);
    for (const [label, assistant] of [
        ["without_reasoning", assistantNoDetails],
        ["with_reasoning", assistantWithDetails],
    ] as const) {
        const body = {
            model,
            messages: [userMsg1, assistant, userMsg2],
            stream: false,
            reasoning: { effort: "high" },
        };
        const res = await POST(body);
        if (!res.ok) {
            console.log(`  ${label}: HTTP ${res.status}: ${await res.text()}`);
            continue;
        }
        const json = (await res.json()) as {
            usage?: { prompt_tokens?: number; completion_tokens?: number };
            choices?: ReadonlyArray<{ message?: { content?: string } }>;
        };
        const p = json.usage?.prompt_tokens ?? 0;
        const c = json.usage?.completion_tokens ?? 0;
        const reply = json.choices?.[0]?.message?.content ?? "";
        console.log(
            `  ${label}: prompt_tokens=${p}, completion=${c}, reply=${JSON.stringify(reply.slice(0, 40))}`,
        );
    }
};

await run("deepseek/deepseek-v4-pro");
await run("anthropic/claude-sonnet-4.6");

console.log(
    "\nINTERPRETATION:\n" +
        "  If prompt_tokens jumps by ~80-100 between without/with: OpenRouter is forwarding the field.\n" +
        "  If prompt_tokens is identical or off by 1-3: OpenRouter is stripping the field for this model.",
);
