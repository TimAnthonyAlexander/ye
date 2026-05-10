#!/usr/bin/env bun
// Evaluate free OpenRouter models for tool-use competence and coding-grade capacity.
// Tries tool_choice: "function" first; falls back to "auto" on rejection.
// Rate-limits itself (250ms between calls) to stay under free-tier caps.
//
// Usage:
//   OPENROUTER_API_KEY=sk-or-... bun run scripts/find-free-models.ts         (dry run)
//   OPENROUTER_API_KEY=sk-or-... bun run scripts/find-free-models.ts --test  (live eval)

const BASE = "https://openrouter.ai/api/v1";
const DELAY_MS = 250;
const TOOL_NAME = "ping";
const TOOL_DESC = "Respond with the string pong to verify tool calling works.";
const TEST_PROMPT = "Call the ping tool.";
const MIN_CONTEXT = 32768; // skip toy models

interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

interface ModelEntry {
  id: string;
  name: string;
  description: string;
  context_length: number;
  pricing: { prompt: string; completion: string; image: string; request: string };
  architecture: { input_modalities?: string[]; output_modalities?: string[]; tokenizer?: string };
  supported_parameters?: string[];
  top_provider: { max_completion_tokens?: number };
}

const PING_TOOL: ToolDef = {
  type: "function",
  function: { name: TOOL_NAME, description: TOOL_DESC, parameters: { type: "object", properties: {}, required: [] } },
};

async function fetchModels(): Promise<ModelEntry[]> {
  const headers = process.env.OPENROUTER_API_KEY
    ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
    : {};
  const res = await fetch(`${BASE}/models`, { headers });
  if (!res.ok) {
    console.error(`HTTP ${res.status}`);
    process.exit(1);
  }
  const json = (await res.json()) as { data?: ModelEntry[] };
  return json.data ?? [];
}

function filter(models: ModelEntry[]): ModelEntry[] {
  return models
    .filter((m) => m.pricing.prompt === "0" && m.pricing.completion === "0")
    .filter((m) => (m.architecture.input_modalities ?? []).includes("text"))
    .filter((m) => m.context_length >= MIN_CONTEXT);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function testToolUse(model: ModelEntry, apiKey: string): Promise<{ ok: boolean; reason: string }> {
  // Strategy 1: strict tool_choice targeting
  const strictBody = {
    model: model.id,
    messages: [{ role: "user", content: TEST_PROMPT }],
    tools: [PING_TOOL],
    tool_choice: { type: "function", function: { name: TOOL_NAME } },
    max_tokens: 128,
    temperature: 0,
  };

  // Strategy 2: tools only, no tool_choice coercion
  const autoBody = {
    model: model.id,
    messages: [{ role: "user", content: TEST_PROMPT }],
    tools: [PING_TOOL],
    max_tokens: 128,
    temperature: 0,
  };

  for (const body of [strictBody, autoBody]) {
    const isStrict = body === strictBody;
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 429) return { ok: false, reason: "rate-limited" };
        if (res.status === 402) return { ok: false, reason: "not actually free" };
        if (isStrict && (text.includes("tool_choice") || text.includes("tool choice"))) {
          continue; // fall through to auto strategy
        }
        return { ok: false, reason: `HTTP ${res.status}` };
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string } }> } }>;
      };
      const toolCalls = json.choices?.[0]?.message?.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        return { ok: false, reason: "no tool call" };
      }
      const calledName = toolCalls[0]?.function?.name;
      if (calledName !== TOOL_NAME) {
        return { ok: false, reason: `wrong tool: ${calledName ?? "?"}` };
      }
      return { ok: true, reason: isStrict ? "passed" : "passed (auto)" };
    } catch (err) {
      return { ok: false, reason: `network: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { ok: false, reason: "rejected both tool_choice modes" };
}

// ── main ──────────────────────────────────────────────────────────────
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY not set");
  process.exit(1);
}

console.error("Fetching models...");
const all = await fetchModels();
const free = filter(all);
console.error(`Total models: ${all.length}, free text ≥${MIN_CONTEXT} ctx: ${free.length}`);

const sorted = free.toSorted((a, b) => b.context_length - a.context_length);

if (process.argv.includes("--test")) {
  console.error("Testing tool use on each free model...\n");
  const results: Array<{ model: ModelEntry; ok: boolean; reason: string }> = [];
  for (const m of sorted) {
    const result = await testToolUse(m, apiKey);
    results.push({ model: m, ...result });
    const flag = result.ok ? "✓" : "✗";
    const ctxLabel = `${(m.context_length / 1000).toFixed(0)}k ctx`;
    console.error(`  ${flag} ${m.id} (${ctxLabel}) — ${result.reason}`);
    await sleep(DELAY_MS);
  }
  console.error("");
  const passed = results.filter((r) => r.ok);
  console.error(`Passed: ${passed.length}/${sorted.length}`);
  for (const r of passed) {
    const m = r.model;
    console.log([m.id, `ctx=${m.context_length}`, `max_out=${m.top_provider.max_completion_tokens ?? "?"}`, `name="${m.name}"`].join("\t"));
  }
} else {
  for (const m of sorted) {
    const hasTools = (m.supported_parameters ?? []).includes("tools");
    const flag = hasTools ? "+tools" : "?tools";
    console.log([m.id, `ctx=${m.context_length}`, `max_out=${m.top_provider.max_completion_tokens ?? "?"}`, flag, `name="${m.name}"`].join("\t"));
  }
}
