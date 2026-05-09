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
        id: "google/gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro Preview",
    },
    { provider: "openrouter", id: "deepseek/deepseek-v4-pro", label: "DeepSeek v4 Pro" },
    {
        provider: "openrouter",
        id: "anthropic/claude-opus-4.7",
        label: "Opus 4.7 (OpenRouter)",
    },
    {
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4.6",
        label: "Sonnet 4.6 (OpenRouter)",
    },
    {
        provider: "openrouter",
        id: "anthropic/claude-haiku-4.5",
        label: "Haiku 4.5 (OpenRouter)",
    },
    { provider: "anthropic", id: "claude-opus-4-7", label: "Opus 4.7" },
    { provider: "anthropic", id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { provider: "anthropic", id: "claude-haiku-4-5", label: "Haiku 4.5" },
    { provider: "openai", id: "gpt-5.5-pro", label: "GPT-5.5 Pro" },
    { provider: "openai", id: "gpt-5.5", label: "GPT-5.5" },
    { provider: "openai", id: "gpt-5.4", label: "GPT-5.4" },
    { provider: "openai", id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { provider: "openai", id: "gpt-5.2-pro", label: "GPT-5.2 Pro" },
    { provider: "openai", id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { provider: "openai", id: "gpt-5.2", label: "GPT-5.2" },
    { provider: "openai", id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
    { provider: "openai", id: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
    { provider: "openai", id: "gpt-5.1", label: "GPT-5.1" },
    { provider: "openai", id: "gpt-5-codex-mini", label: "GPT-5 Codex Mini" },
    { provider: "openai", id: "gpt-5", label: "GPT-5" },
    { provider: "openai", id: "gpt-5-mini", label: "GPT-5 Mini" },
    { provider: "openai", id: "codex-mini-latest", label: "Codex Mini Latest" },
    { provider: "openai", id: "gpt-4.1", label: "GPT-4.1" },
    { provider: "openai", id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
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
