import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getProjectMemoryDir } from "../../storage/paths.ts";
import { atomicWrite } from "../fs.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface SaveMemoryArgs {
    readonly title: string;
    readonly hook: string;
    readonly content: string;
}

interface SaveMemoryResult {
    readonly path: string;
    readonly indexPath: string;
}

const slugify = (title: string): string => {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return slug.length > 0 ? slug : "memory";
};

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

const execute = async (
    rawArgs: unknown,
    ctx: ToolContext,
): Promise<ToolResult<SaveMemoryResult>> => {
    const v = validateArgs<SaveMemoryArgs>(rawArgs, SaveMemoryTool.schema);
    if (!v.ok) return v;

    const title = oneLine(v.value.title);
    const hook = oneLine(v.value.hook);
    const content = v.value.content;

    if (title.length === 0) return { ok: false, error: "title must be non-empty" };
    if (hook.length === 0) return { ok: false, error: "hook must be non-empty" };
    if (content.trim().length === 0) {
        return { ok: false, error: "content must be non-empty" };
    }

    const dir = getProjectMemoryDir(ctx.projectId);
    await mkdir(dir, { recursive: true });

    const filename = `${slugify(title)}.md`;
    const path = join(dir, filename);
    if (await Bun.file(path).exists()) {
        return {
            ok: false,
            error: `memory already exists at ${filename}. Pick a more specific title or update the existing file directly.`,
        };
    }

    await atomicWrite(path, content.endsWith("\n") ? content : `${content}\n`);

    const indexPath = join(dir, "MEMORY.md");
    const indexEntry = `- [${title}](${filename}) — ${hook}\n`;
    const existing = (await Bun.file(indexPath).exists()) ? await Bun.file(indexPath).text() : "";
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await atomicWrite(indexPath, `${existing}${separator}${indexEntry}`);

    return { ok: true, value: { path, indexPath } };
};

export const SaveMemoryTool: Tool<SaveMemoryArgs, SaveMemoryResult> = {
    name: "SaveMemory",
    description:
        "Save a memory to the current project's memory store. Writes a new markdown file " +
        "under the project's memory directory and appends an index entry to MEMORY.md, so " +
        "the memory becomes available for auto-selection in future sessions on this project. " +
        "Use this for facts, preferences, or feedback that should outlive the current session. " +
        "Args: `title` (short label, becomes the filename), `hook` (one-line summary used to " +
        "decide relevance later), `content` (the memory body in markdown).",
    annotations: { readOnlyHint: false },
    schema: {
        type: "object",
        required: ["title", "hook", "content"],
        properties: {
            title: { type: "string" },
            hook: { type: "string" },
            content: { type: "string" },
        },
    },
    execute,
};
