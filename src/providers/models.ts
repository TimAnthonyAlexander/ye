import type { ProviderId } from "../config/index.ts";

export interface ModelInfo {
    readonly provider: ProviderId;
    readonly id: string;
    readonly label: string;
}

// Single source of truth for the user-facing model picker. Add new entries here;
// no other file enumerates models. The `id` is the provider-native model name
// passed to the API; `label` is what appears in the picker.
const MODELS: readonly ModelInfo[] = [
    { provider: "openrouter", id: "~google/gemini-flash-latest", label: "Gemini Flash (latest)" },
    {
        provider: "openrouter",
        id: "google/gemini-2.5-flash-lite",
        label: "Gemini 2.5 Flash Lite",
    },
    {
        provider: "openrouter",
        id: "google/gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro Preview",
    },
    {
        provider: "openrouter",
        id: "deepseek/deepseek-v4-pro",
        label: "DeepSeek v4 Pro (OpenRouter)",
    },
    { provider: "deepseek", id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { provider: "deepseek", id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    {
        provider: "openrouter",
        id: "anthropic/claude-opus-4.8",
        label: "Opus 4.8 (OpenRouter)",
    },
    {
        provider: "openrouter",
        id: "anthropic/claude-opus-5",
        label: "Opus 5 (OpenRouter)",
    },
    {
        provider: "openrouter",
        id: "anthropic/claude-opus-4.7",
        label: "Opus 4.7 (OpenRouter)",
    },
    {
        provider: "openrouter",
        id: "anthropic/claude-sonnet-5",
        label: "Sonnet 5 (OpenRouter)",
    },
    {
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4.6",
        label: "Sonnet 4.6 (OpenRouter)",
    },
    {
        provider: "openrouter",
        id: "anthropic/claude-fable-5",
        label: "Fable 5 (OpenRouter)",
    },
    {
        provider: "openrouter",
        id: "anthropic/claude-haiku-4.5",
        label: "Haiku 4.5 (OpenRouter)",
    },
    { provider: "anthropic", id: "claude-opus-4-8", label: "Opus 4.8" },
    { provider: "anthropic", id: "claude-opus-5", label: "Opus 5" },
    { provider: "anthropic", id: "claude-opus-4-7", label: "Opus 4.7" },
    { provider: "anthropic", id: "claude-sonnet-5", label: "Sonnet 5" },
    { provider: "anthropic", id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { provider: "anthropic", id: "claude-fable-5", label: "Fable 5" },
    { provider: "anthropic", id: "claude-haiku-4-5", label: "Haiku 4.5" },
    // Subscription models via the local dario proxy. Opus 4.8 leads so
    // defaultModelFor picks it, matching the anthropic provider. `[1m]` is
    // dario's long-context label, not an upstream model id.
    { provider: "dario", id: "claude-opus-4-8", label: "Opus 4.8 (Subscription)" },
    { provider: "dario", id: "claude-opus-4-8[1m]", label: "Opus 4.8 · 1M (Subscription)" },
    { provider: "dario", id: "claude-opus-5", label: "Opus 5 (Subscription)" },
    { provider: "dario", id: "claude-opus-5[1m]", label: "Opus 5 · 1M (Subscription)" },
    { provider: "dario", id: "claude-sonnet-5", label: "Sonnet 5 (Subscription)" },
    { provider: "dario", id: "claude-sonnet-5[1m]", label: "Sonnet 5 · 1M (Subscription)" },
    { provider: "dario", id: "claude-fable-5", label: "Fable 5 (Subscription)" },
    { provider: "dario", id: "claude-fable-5[1m]", label: "Fable 5 · 1M (Subscription)" },
    { provider: "dario", id: "claude-haiku-4-5", label: "Haiku 4.5 (Subscription)" },
    { provider: "openai", id: "gpt-5.5-pro", label: "GPT-5.5 Pro" },
    { provider: "openai", id: "gpt-5.5", label: "GPT-5.5" },
    { provider: "openai", id: "gpt-5.4", label: "GPT-5.4" },
    { provider: "openai", id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { provider: "openai", id: "gpt-5.2-pro", label: "GPT-5.2 Pro" },
    { provider: "openai", id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { provider: "openai", id: "gpt-5.2", label: "GPT-5.2" },
    { provider: "openai", id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
    { provider: "openai", id: "gpt-5.1", label: "GPT-5.1" },
    { provider: "openai", id: "gpt-5", label: "GPT-5" },
    { provider: "openai", id: "gpt-4.1", label: "GPT-4.1" },
    // Ollama models are user-installed locally — these are placeholders that
    // appear in /model alongside whatever /api/tags reports as actually pulled.
    { provider: "ollama", id: "qwen3", label: "Qwen3 (Ollama)" },
    { provider: "ollama", id: "llama3.2", label: "Llama 3.2 (Ollama)" },
    { provider: "ollama", id: "gpt-oss:20b", label: "GPT-OSS 20B (Ollama)" },
];

export const listModels = (providerId?: string): readonly ModelInfo[] =>
    providerId ? MODELS.filter((m) => m.provider === providerId) : MODELS;

export const findModel = (id: string): ModelInfo | undefined => MODELS.find((m) => m.id === id);

export const findModelLabel = (id: string): string => findModel(id)?.label ?? id;

// First model registered for a provider. Used as the fallback when switching
// providers via /provider — we pick a sensible default model rather than
// inheriting a model from a different provider.
export const defaultModelFor = (providerId: string): ModelInfo | undefined =>
    MODELS.find((m) => m.provider === providerId);
