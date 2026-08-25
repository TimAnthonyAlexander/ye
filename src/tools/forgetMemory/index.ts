import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { removeMemoryEntry } from "../../memory/memoryIndex.ts";
import { getProjectMemoryDir } from "../../storage/paths.ts";
import { atomicWrite } from "../fs.ts";
import { memorySlug } from "../saveMemory/index.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface ForgetMemoryArgs {
    readonly title: string;
}

interface ForgetMemoryResult {
    readonly path: string;
    readonly indexEntriesRemoved: number;
}

// The index line shows both the title and the filename, so a model asked to
// remove a memory reaches for either. Both resolve to the same file.
const filenameFor = (title: string): string =>
    title.endsWith(".md") ? title : `${memorySlug(title)}.md`;

const execute = async (
    rawArgs: unknown,
    ctx: ToolContext,
): Promise<ToolResult<ForgetMemoryResult>> => {
    const v = validateArgs<ForgetMemoryArgs>(rawArgs, ForgetMemoryTool.schema);
    if (!v.ok) return v;

    const title = v.value.title.trim();
    if (title.length === 0) return { ok: false, error: "title must be non-empty" };

    const dir = getProjectMemoryDir(ctx.projectId);
    const filename = filenameFor(title);
    const path = join(dir, filename);
    const indexPath = join(dir, "MEMORY.md");

    const fileExisted = await Bun.file(path).exists();

    // The file and the index line are removed independently: a half-written
    // save, or a hand-edited index, leaves one without the other, and this is
    // the tool that has to clean either up.
    let indexEntriesRemoved = 0;
    if (await Bun.file(indexPath).exists()) {
        const before = await Bun.file(indexPath).text();
        const { text, removed } = removeMemoryEntry(before, filename);
        indexEntriesRemoved = removed;
        if (removed > 0) await atomicWrite(indexPath, text);
    }

    if (!fileExisted && indexEntriesRemoved === 0) {
        return {
            ok: false,
            error: `no memory named "${title}" in this project (looked for ${filename}). Read ${indexPath} for the titles that exist.`,
        };
    }

    if (fileExisted) await unlink(path);

    return { ok: true, value: { path, indexEntriesRemoved } };
};

export const ForgetMemoryTool: Tool<ForgetMemoryArgs, ForgetMemoryResult> = {
    name: "ForgetMemory",
    description:
        "Delete a memory from the current project's memory store: removes the markdown file " +
        "SaveMemory wrote and its entry in MEMORY.md, so it stops being offered for " +
        "auto-selection in future sessions. Use it when a memory turns out to be wrong, " +
        "obsolete, or was only ever a throwaway. Args: `title` — the title the memory was " +
        "saved under, or its filename as shown in the index.",
    annotations: { readOnlyHint: false, destructive: true },
    schema: {
        type: "object",
        required: ["title"],
        properties: {
            title: { type: "string" },
        },
    },
    execute,
};
