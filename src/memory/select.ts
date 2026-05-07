import { join } from "node:path";
import type { Config } from "../config/index.ts";
import type { Provider } from "../providers/index.ts";
import { GLOBAL_MEMORY_FILE, getProjectMemoryDir } from "../storage/paths.ts";
import { parseMemoryIndex, type MemoryEntry } from "./memoryIndex.ts";

export interface MemoryFile {
    readonly path: string;
    readonly title: string;
    readonly content: string;
}

const SELECT_SYSTEM =
    "You select memory files relevant to a user query. " +
    "Reply with ONLY a JSON array of 1-based indices. " +
    "No prose, no markdown fences. Empty array if none are relevant.";

const INDEX_RE = /\[\s*(\d+(?:\s*,\s*\d+)*)?\s*\]/;

const parseIndexResponse = (text: string, count: number, max: number): readonly number[] => {
    const m = INDEX_RE.exec(text);
    if (!m || !m[1]) return [];
    const seen = new Set<number>();
    const out: number[] = [];
    for (const part of m[1].split(",")) {
        const n = Number.parseInt(part.trim(), 10);
        if (!Number.isInteger(n)) continue;
        if (n < 1 || n > count) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(n);
        if (out.length >= max) break;
    }
    return out;
};

export const readAllMemoryIndices = async (projectId: string): Promise<readonly MemoryEntry[]> => {
    const global = await parseMemoryIndex(GLOBAL_MEMORY_FILE);
    const projectIndex = join(getProjectMemoryDir(projectId), "MEMORY.md");
    const project = await parseMemoryIndex(projectIndex);
    return [...global, ...project];
};

export interface SelectMemoryInput {
    readonly provider: Provider;
    readonly model: string;
    readonly providerOptions?: Readonly<Record<string, unknown>>;
    readonly query: string;
    readonly indices: readonly MemoryEntry[];
    readonly max?: number;
}

export const selectMemoryFiles = async (
    input: SelectMemoryInput,
): Promise<readonly MemoryFile[]> => {
    if (input.indices.length === 0) return [];
    if (input.query.trim().length === 0) return [];
    const max = input.max ?? 5;

    const headers = input.indices
        .map((e, i) => `${i + 1}. ${e.title} — ${e.hook}`)
        .join("\n");
    const userMsg =
        `Memory files:\n${headers}\n\n` +
        `User query: ${input.query}\n\n` +
        `Respond with a JSON array of up to ${max} 1-based indices, e.g. [1,3]. ` +
        `Empty array if none are relevant.`;

    let text = "";
    try {
        for await (const evt of input.provider.stream({
            model: input.model,
            messages: [
                { role: "system", content: SELECT_SYSTEM },
                { role: "user", content: userMsg },
            ],
            ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        })) {
            if (evt.type === "text.delta") text += evt.text;
            if (evt.type === "stop") break;
        }
    } catch {
        return [];
    }

    const ids = parseIndexResponse(text, input.indices.length, max);
    const files: MemoryFile[] = [];
    for (const id of ids) {
        const entry = input.indices[id - 1];
        if (!entry) continue;
        try {
            const content = await Bun.file(entry.path).text();
            if (content.trim().length === 0) continue;
            files.push({ path: entry.path, title: entry.title, content });
        } catch {
            // unreadable — skip
        }
    }
    return files;
};

export interface EnsureMemoryInput {
    readonly projectId: string;
    readonly query: string;
    readonly provider: Provider;
    readonly config: Config;
}

export const ensureSelectedMemory = async (
    input: EnsureMemoryInput,
): Promise<readonly MemoryFile[]> => {
    const indices = await readAllMemoryIndices(input.projectId);
    if (indices.length === 0) return [];
    return selectMemoryFiles({
        provider: input.provider,
        model: input.config.defaultModel.model,
        providerOptions: {
            providerOrder: input.config.defaultModel.providerOrder,
            allowFallbacks: input.config.defaultModel.allowFallbacks,
        },
        query: input.query,
        indices,
    });
};
