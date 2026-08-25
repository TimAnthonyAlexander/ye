import type { Skill, SkillManifest, SkillSource } from "./types.ts";
import { SkillError } from "./types.ts";

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const BLOCK_ITEM_PATTERN = /^\s*-\s+(.*)$/;

interface ParseInput {
    readonly text: string;
    readonly source: SkillSource;
    readonly directoryName: string | null;
    // Claude Code derives a skill's identity from its directory name; the
    // frontmatter `name` is an optional display label that need not match. For
    // ~/.claude and .claude sources we follow that rule so a SKILL.md written
    // for Claude Code loads unchanged instead of being dropped on a mismatch.
    readonly nameFromDirectory?: boolean;
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

export const parseFrontmatter = (
    block: string,
): { fields: ReadonlyMap<string, string>; error: string | null } => {
    const fields = new Map<string, string>();
    const lines = block.split("\n");
    // A key with an empty inline value opens a YAML block sequence; its `- item`
    // lines are folded into one comma-joined string so every consumer sees the
    // same shape as the inline forms. Those lines were a hard parse error
    // before, so folding them can only widen what loads.
    let listKey: string | null = null;
    for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        if (line.trim().length === 0) continue;
        if (line.startsWith("#")) continue;
        const item = BLOCK_ITEM_PATTERN.exec(line);
        if (item && listKey !== null) {
            const existing = fields.get(listKey) ?? "";
            const value = stripQuotes(item[1] ?? "");
            fields.set(listKey, existing.length > 0 ? `${existing},${value}` : value);
            continue;
        }
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) {
            return { fields, error: `malformed frontmatter line: ${line}` };
        }
        const key = line.slice(0, colonIdx).trim();
        const value = stripQuotes(line.slice(colonIdx + 1));
        fields.set(key, value);
        listKey = value.length === 0 ? key : null;
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

// Skill files are user-authored, so every value here is untrusted input:
// anything that doesn't look like the field it claims to be is dropped and the
// rest of the skill still loads. Lists accept inline arrays, commas and bare
// whitespace separation — all three appear in the wild.
const parseToolList = (raw: string | undefined): readonly string[] | undefined => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
    const names = inner
        .split(/[,\s]+/)
        .map((part) => stripQuotes(part))
        .filter((part) => TOOL_NAME_PATTERN.test(part));
    return names.length > 0 ? names : undefined;
};

const parseModelId = (raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) return undefined;
    return trimmed;
};

const parseText = (raw: string | undefined, maxLength: number): string | undefined => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > maxLength) return undefined;
    return trimmed;
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

    // Claude Code sources: identity is the directory name, `name` is an
    // optional label. Ye sources: `name` is required and must match the
    // directory.
    const name =
        input.nameFromDirectory === true
            ? (input.directoryName ?? parsed.fields.get("name"))
            : parsed.fields.get("name");
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

    if (
        input.nameFromDirectory !== true &&
        input.directoryName !== null &&
        input.directoryName !== name
    ) {
        return new SkillError(
            input.source.path,
            `directory name '${input.directoryName}' does not match frontmatter name '${name}'`,
        );
    }

    // Keys outside this set are tolerated and ignored — a SKILL.md written for
    // another agent must still load here.
    const disableModelInvocation = parseBoolean(parsed.fields.get("disable-model-invocation"));
    const userInvocable = parseBoolean(parsed.fields.get("user-invocable"));
    const allowedTools = parseToolList(parsed.fields.get("allowed-tools"));
    const disallowedTools = parseToolList(parsed.fields.get("disallowed-tools"));
    const model = parseModelId(parsed.fields.get("model"));
    const argumentHint = parseText(parsed.fields.get("argument-hint"), 256);

    const manifest: SkillManifest = {
        name,
        description,
        ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
        ...(userInvocable !== undefined ? { userInvocable } : {}),
        ...(allowedTools !== undefined ? { allowedTools } : {}),
        ...(disallowedTools !== undefined ? { disallowedTools } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(argumentHint !== undefined ? { argumentHint } : {}),
    };

    return { manifest, body, source: input.source };
};
