export type SkillTier = "builtin" | "managed" | "claude" | "user" | "project";

export interface SkillSource {
    readonly tier: SkillTier;
    readonly path: string;
    readonly directory: string | null;
}

export interface SkillManifest {
    readonly name: string;
    readonly description: string;
    readonly disableModelInvocation?: boolean;
}

export interface Skill {
    readonly manifest: SkillManifest;
    readonly body: string;
    readonly source: SkillSource;
}

export class SkillError extends Error {
    constructor(
        readonly path: string,
        message: string,
    ) {
        super(`${path}: ${message}`);
        this.name = "SkillError";
    }
}

export interface SkillRegistry {
    readonly all: ReadonlyMap<string, Skill>;
    readonly modelInvocable: readonly Skill[];
    readonly slashBound: readonly Skill[];
}
