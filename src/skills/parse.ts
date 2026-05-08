import type { Skill, SkillManifest, SkillSource } from "./types.ts";
import { SkillError } from "./types.ts";

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

interface ParseInput {
    readonly text: string;
    readonly source: SkillSource;
    readonly directoryName: string | null;
}

const stripQuotes = (raw: string): string => {
    const trimmed = raw.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
};

const parseFrontmatter = (
    block: string,
): { fields: ReadonlyMap<string, string>; error: string | null } => {
    const fields = new Map<string, string>();
    const lines = block.split("\n");
    for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        if (line.trim().length === 0) continue;
        if (line.startsWith("#")) continue;
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) {
            return { fields, error: `malformed frontmatter line: ${line}` };
        }
        const key = line.slice(0, colonIdx).trim();
        const value = stripQuotes(line.slice(colonIdx + 1));
        fields.set(key, value);
    }
    return { fields, error: null };
};

const parseBoolean = (raw: string | undefined): boolean | undefined => {
    if (raw === undefined) return undefined;
    const v = raw.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    return undefined;
};

export const parseSkillFile = (input: ParseInput): Skill | SkillError => {
    const text = input.text.replace(/^﻿/, "");
    const lines = text.split("\n");
    if (lines[0]?.trim() !== "---") {
        return new SkillError(input.source.path, "missing frontmatter delimiter at line 1");
    }
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === "---") {
            endIdx = i;
            break;
        }
    }
    if (endIdx === -1) {
        return new SkillError(input.source.path, "missing closing frontmatter delimiter");
    }

    const frontmatterBlock = lines.slice(1, endIdx).join("\n");
    const body = lines
        .slice(endIdx + 1)
        .join("\n")
        .replace(/^\n+/, "")
        .replace(/\s+$/, "");

    const parsed = parseFrontmatter(frontmatterBlock);
    if (parsed.error) {
        return new SkillError(input.source.path, parsed.error);
    }

    const name = parsed.fields.get("name");
    const description = parsed.fields.get("description");

    if (!name || name.length === 0) {
        return new SkillError(input.source.path, "frontmatter 'name' is required");
    }
    if (!NAME_PATTERN.test(name)) {
        return new SkillError(
            input.source.path,
            `frontmatter 'name' must match /^[a-z][a-z0-9-]*$/, got: ${name}`,
        );
    }
    if (name.length > 64) {
        return new SkillError(input.source.path, "frontmatter 'name' exceeds 64 chars");
    }
    if (!description || description.length === 0) {
        return new SkillError(input.source.path, "frontmatter 'description' is required");
    }
    if (description.length > 1024) {
        return new SkillError(input.source.path, "frontmatter 'description' exceeds 1024 chars");
    }

    if (input.directoryName !== null && input.directoryName !== name) {
        return new SkillError(
            input.source.path,
            `directory name '${input.directoryName}' does not match frontmatter name '${name}'`,
        );
    }

    // Unknown frontmatter keys (allowed-tools, model, version, etc.) are
    // tolerated and ignored. Skills are knowledge injection, not sandboxes —
    // tool gating is the permission system's job, not this manifest's. Keys
    // are preserved on disk for portability with the open Agent Skills format,
    // they just don't shape Ye's behavior.
    const disableModelInvocation = parseBoolean(parsed.fields.get("disable-model-invocation"));

    const manifest: SkillManifest = {
        name,
        description,
        ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    };

    return { manifest, body, source: input.source };
};
