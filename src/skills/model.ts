import { findModel } from "../providers/index.ts";

// Providers whose catalogue is discovered at runtime (OpenRouter's free-model
// scan, Ollama's local tags), so an id missing from models.ts is not evidence
// that it is unusable. Every other provider has a closed, registered list.
const DYNAMIC_CATALOGUE_PROVIDERS: readonly string[] = ["openrouter", "ollama"];

export interface SkillModelResolution {
    // null when the requested model isn't usable on the active provider — the
    // caller keeps the active model and surfaces `notice`.
    readonly model: string | null;
    readonly notice: string | null;
}

export const resolveSkillModel = (input: {
    readonly skillName: string;
    readonly requested: string;
    readonly providerId: string;
    readonly activeModel: string;
}): SkillModelResolution => {
    const { skillName, requested, providerId, activeModel } = input;
    if (requested === activeModel) return { model: requested, notice: null };

    const known = findModel(requested);
    const resolvable =
        known !== undefined
            ? known.provider === providerId
            : DYNAMIC_CATALOGUE_PROVIDERS.includes(providerId);
    if (resolvable) return { model: requested, notice: null };

    return {
        model: null,
        notice:
            `Note: skill "${skillName}" requests model "${requested}", which is not available on ` +
            `provider "${providerId}" — continuing on "${activeModel}".`,
    };
};
