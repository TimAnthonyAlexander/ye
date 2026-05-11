import { describe, expect, test } from "bun:test";
import { buildSmallSystemPrompt, buildSystemPrompt, type SystemPromptEnv } from "./systemPrompt.ts";

const env = (overrides: Partial<SystemPromptEnv> = {}): SystemPromptEnv => ({
    cwd: "/tmp/proj",
    mode: "NORMAL",
    model: "gpt-5-codex",
    platform: "darwin",
    date: "2026-05-11",
    providerId: "openai",
    ...overrides,
});

const PERSISTENCE_MARKER = "# Persistence";

describe("buildSystemPrompt — small-prompt routing", () => {
    test("R1 ollama provider always routes to small prompt", () => {
        const full = buildSystemPrompt(env({ providerId: "ollama", model: "llama3.1:70b" }));
        const small = buildSmallSystemPrompt(env({ providerId: "ollama", model: "llama3.1:70b" }));
        expect(full).toBe(small);
    });

    test("R2 model name with `-mini` segment routes to small prompt", () => {
        const out = buildSystemPrompt(env({ model: "gpt-5.1-codex-mini" }));
        const small = buildSmallSystemPrompt(env({ model: "gpt-5.1-codex-mini" }));
        expect(out).toBe(small);
    });

    test("R3 model name with `-nano` segment routes to small prompt", () => {
        const out = buildSystemPrompt(env({ model: "gpt-5.4-nano" }));
        const small = buildSmallSystemPrompt(env({ model: "gpt-5.4-nano" }));
        expect(out).toBe(small);
    });

    test("R4 `gemini` (contains 'mini' as substring) does NOT trigger small prompt", () => {
        const out = buildSystemPrompt(
            env({ providerId: "openrouter", model: "google/gemini-flash-latest" }),
        );
        const small = buildSmallSystemPrompt(
            env({ providerId: "openrouter", model: "google/gemini-flash-latest" }),
        );
        // Full prompt is much longer than the small one — direct sanity check.
        expect(out).not.toBe(small);
        expect(out.length).toBeGreaterThan(small.length * 3);
    });

    test("R5 non-mini OpenAI model gets the full prompt with persistence block", () => {
        const out = buildSystemPrompt(env({ model: "gpt-5-codex" }));
        expect(out).toContain("# Persistence (OpenAI agentic loop)");
    });
});

describe("buildSmallSystemPrompt — OpenAI persistence", () => {
    test("R6 OpenAI + NORMAL includes the persistence block", () => {
        const out = buildSmallSystemPrompt(env({ providerId: "openai", mode: "NORMAL" }));
        expect(out).toContain(PERSISTENCE_MARKER);
    });

    test("R7 OpenAI + AUTO includes the persistence block", () => {
        const out = buildSmallSystemPrompt(env({ providerId: "openai", mode: "AUTO" }));
        expect(out).toContain(PERSISTENCE_MARKER);
    });

    test("R8 OpenAI + PLAN omits the persistence block (PLAN is conversational)", () => {
        const out = buildSmallSystemPrompt(env({ providerId: "openai", mode: "PLAN" }));
        expect(out).not.toContain(PERSISTENCE_MARKER);
    });

    test("R9 non-OpenAI providers never get the persistence block, regardless of mode", () => {
        for (const providerId of ["ollama", "anthropic", "openrouter", "deepseek"]) {
            for (const mode of ["NORMAL", "AUTO", "PLAN"] as const) {
                const out = buildSmallSystemPrompt(env({ providerId, mode }));
                expect(out).not.toContain(PERSISTENCE_MARKER);
            }
        }
    });

    test("R10 small + OpenAI + mini model carries through buildSystemPrompt", () => {
        const out = buildSystemPrompt(
            env({ providerId: "openai", model: "gpt-5.1-codex-mini", mode: "NORMAL" }),
        );
        expect(out).toContain(PERSISTENCE_MARKER);
        // And it's the small prompt — full would contain the bigger persistence header.
        expect(out).not.toContain("# Persistence (OpenAI agentic loop)");
    });
});
