import type { Config } from "../config/index.ts";
import { readNotesHierarchy } from "../memory/index.ts";
import type { SessionState } from "../pipeline/state.ts";
import { estimateTokens } from "../pipeline/shapers/tokens.ts";
import { buildSystemPrompt } from "../pipeline/systemPrompt.ts";
import { findModelLabel } from "../providers/models.ts";
import type { SkillRegistry, SkillTier } from "../skills/types.ts";
import { listTools } from "../tools/registry.ts";
import { toToolDefinition } from "../tools/types.ts";

// Same chars/4 yardstick used by the shaper chain (pipeline/shapers/tokens.ts).
// /context numbers MUST match what the shapers see — otherwise users will see
// "OK" here while a shaper triggers, or vice versa. If a provider gains a real
// countTokens later, we can switch this whole module over in one place.
const tokensOf = (s: string): number => Math.ceil(s.length / 4);
const tokensOfJson = (v: unknown): number => Math.ceil(JSON.stringify(v).length / 4);

export type SegmentKey = "system" | "tools" | "memory" | "skills" | "messages";

export interface ContextSegment {
    readonly key: SegmentKey;
    readonly label: string;
    readonly tokens: number;
}

export interface MemoryFileEntry {
    readonly path: string;
    readonly tokens: number;
}

export interface SkillEntry {
    readonly name: string;
    readonly tier: SkillTier;
    readonly tokens: number;
}

export interface ContextSnapshot {
    readonly providerId: string;
    readonly model: string;
    readonly modelLabel: string;
    // Model's true max input. Shown as a label hint; not the math denominator.
    readonly contextWindow: number;
    readonly autocompactThreshold: number;
    // The effective working window (= contextWindow × threshold). Auto-compact
    // fires when the assembled prompt exceeds this. ALL percentages and the
    // grid are relative to this number — the portion past the trigger is
    // irrelevant because compaction runs before we get there.
    readonly autocompactWindow: number;
    readonly segments: readonly ContextSegment[];
    readonly totalUsed: number;
    readonly free: number;
    // Output reserve: tokens kept clear at the top of the working window for
    // the model's own reply. Without this, a barely-fitting prompt would force
    // maxTokens down to nothing.
    readonly outputReserve: number;
    readonly memoryFiles: readonly MemoryFileEntry[];
    readonly skills: readonly SkillEntry[];
}

export interface BuildSnapshotInput {
    readonly state: SessionState;
    readonly providerId: string;
    readonly model: string;
    readonly config: Config;
    readonly skillRegistry: SkillRegistry;
    readonly username?: string;
}

export const buildContextSnapshot = async (input: BuildSnapshotInput): Promise<ContextSnapshot> => {
    const { state, providerId, model, config, skillRegistry, username } = input;

    const systemBody = buildSystemPrompt({
        cwd: state.projectRoot,
        mode: state.mode,
        model,
        platform: process.platform,
        date: new Date().toISOString().slice(0, 10),
        providerId,
        ...(username ? { username } : {}),
    });
    const systemTokens = tokensOf(systemBody);

    const toolDefs = listTools().map(toToolDefinition);
    const toolsTokens = tokensOfJson(toolDefs);

    const notes = await readNotesHierarchy(state.projectRoot);
    const memoryFiles: MemoryFileEntry[] = [];
    let memoryTokens = 0;
    if (notes.length > 0) {
        const t = tokensOf(notes);
        memoryFiles.push({ path: "project notes (CLAUDE.md / YE.md)", tokens: t });
        memoryTokens += t;
    }
    if (state.selectedMemory) {
        for (const entry of state.selectedMemory) {
            const t = tokensOf(entry.content);
            memoryFiles.push({ path: entry.path, tokens: t });
            memoryTokens += t;
        }
    }

    const skills: SkillEntry[] = [];
    let skillsTokens = 0;
    for (const skill of skillRegistry.slashBound) {
        const desc = skill.manifest.description;
        // Skill bodies load on demand (the SkillTool reads them when invoked).
        // What sits in the assembled prompt is the skill name + description as
        // part of the SkillTool's catalog, so that's what we count here.
        const t = tokensOf(`${skill.manifest.name}: ${desc}`);
        skills.push({ name: skill.manifest.name, tier: skill.source.tier, tokens: t });
        skillsTokens += t;
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));

    const messagesTokens = estimateTokens(state.history);

    const totalUsed = systemTokens + toolsTokens + memoryTokens + skillsTokens + messagesTokens;
    const contextWindow = state.contextWindow;
    const threshold = config.compact?.threshold ?? 0.5;
    const autocompactWindow = Math.floor(contextWindow * threshold);
    const desiredReserve = config.compact?.defaultMaxTokens ?? 16_384;
    // Don't let the reserve eat more than half the working window — on tiny
    // models the configured 16k default would otherwise dominate the grid.
    const outputReserve = Math.min(desiredReserve, Math.floor(autocompactWindow / 2));
    const free = Math.max(0, autocompactWindow - totalUsed - outputReserve);

    return {
        providerId,
        model,
        modelLabel: findModelLabel(model),
        contextWindow,
        autocompactThreshold: threshold,
        autocompactWindow,
        segments: [
            { key: "system", label: "System prompt", tokens: systemTokens },
            { key: "tools", label: "System tools", tokens: toolsTokens },
            { key: "memory", label: "Memory files", tokens: memoryTokens },
            { key: "skills", label: "Skills", tokens: skillsTokens },
            { key: "messages", label: "Messages", tokens: messagesTokens },
        ],
        totalUsed,
        free,
        outputReserve,
        memoryFiles,
        skills,
    };
};
