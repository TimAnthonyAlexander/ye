import { parseFrontmatter } from "../../skills/parse.ts";
import type { AgentSource } from "../types.ts";

export interface CustomAgent {
    readonly name: string;
    readonly description: string;
    readonly source: AgentSource;
    readonly path: string;
    readonly body: string;
    readonly tools?: readonly string[];
    readonly model?: string;
    readonly maxTurns?: number;
}

export interface ParseAgentInput {
    readonly text: string;
    readonly path: string;
    readonly fileName: string;
    readonly source: AgentSource;
    // Claude Code identifies an agent by its frontmatter `name` alone; the
    // filename need not match. For .claude sources we follow that so an agent
    // file written for Claude Code loads unchanged instead of being dropped.
    readonly nameFromFrontmatter?: boolean;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

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

const parseTurns = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n < 1 || n > 1000) return undefined;
    return n;
};

// Agent files are user-authored, so this is a system boundary: anything that
// doesn't parse returns null and the caller drops that one file. A bad field
// that isn't required (model, tools, maxTurns) is dropped on its own and the
// agent still loads.
export const parseAgentFile = (input: ParseAgentInput): CustomAgent | null => {
    const text = input.text.replace(/^﻿/, "");
    const lines = text.split("\n");
    if (lines[0]?.trim() !== "---") return null;

    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === "---") {
            endIdx = i;
            break;
        }
    }
    if (endIdx === -1) return null;

    const parsed = parseFrontmatter(lines.slice(1, endIdx).join("\n"));
    if (parsed.error) return null;

    const name = parsed.fields.get("name");
    const description = parsed.fields.get("description");
    if (!name || !NAME_PATTERN.test(name) || name.length > 64) return null;
    if (!description || description.length === 0 || description.length > 1024) return null;
    if (input.nameFromFrontmatter !== true && name !== input.fileName) return null;

    const body = lines
        .slice(endIdx + 1)
        .join("\n")
        .replace(/^\n+/, "")
        .replace(/\s+$/, "");
    if (body.length === 0) return null;

    const tools = parseToolList(parsed.fields.get("tools"));
    const model = parseModelId(parsed.fields.get("model"));
    const maxTurns = parseTurns(parsed.fields.get("maxTurns"));

    return {
        name,
        description,
        source: input.source,
        path: input.path,
        body,
        ...(tools !== undefined ? { tools } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
};
