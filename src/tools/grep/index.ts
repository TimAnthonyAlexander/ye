import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

type GrepMode = "content" | "files_with_matches" | "count";

interface GrepArgs {
    readonly pattern: string;
    readonly path?: string;
    readonly output_mode?: GrepMode;
    readonly type?: string; // ripgrep --type filter, e.g. "ts"
    readonly glob?: string; // path glob filter
}

const OUTPUT_CAP = 32_000;

const truncate = (text: string): string =>
    text.length > OUTPUT_CAP
        ? `${text.slice(0, OUTPUT_CAP)}\n…(truncated, ${text.length - OUTPUT_CAP} more chars)`
        : text;

const flagsForMode = (mode: GrepMode): string[] => {
    switch (mode) {
        case "files_with_matches":
            return ["-l"];
        case "count":
            return ["-c"];
        case "content":
            return ["-n"];
    }
};

const execute = async (
    rawArgs: unknown,
    ctx: ToolContext,
): Promise<ToolResult<{ output: string; exitCode: number }>> => {
    const v = validateArgs<GrepArgs>(rawArgs, GrepTool.schema);
    if (!v.ok) return v;
    const { pattern, path = ctx.cwd, output_mode = "content", type, glob } = v.value;

    const args = ["rg", "--no-heading", "--color", "never", ...flagsForMode(output_mode)];
    if (type) args.push("-t", type);
    if (glob) args.push("-g", glob);
    args.push(pattern, path);

    const proc = Bun.spawn({
        cmd: args,
        cwd: ctx.cwd,
        stdout: "pipe",
        stderr: "pipe",
        signal: ctx.signal,
    });

    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    // ripgrep: exit 1 = no matches (not an error)
    if (exitCode !== 0 && exitCode !== 1) {
        return {
            ok: false,
            error: stderr.trim() || `rg exited with code ${exitCode}`,
        };
    }

    return { ok: true, value: { output: truncate(stdout), exitCode } };
};

export const GrepTool: Tool = {
    name: "Grep",
    description:
        "Search file contents using ripgrep. Modes: content (matching lines, default), " +
        "files_with_matches (paths only), count (matches per file). Supports type/glob filters.",
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        required: ["pattern"],
        properties: {
            pattern: { type: "string" },
            path: { type: "string" },
            output_mode: {
                type: "string",
                enum: ["content", "files_with_matches", "count"],
            },
            type: { type: "string" },
            glob: { type: "string" },
        },
    },
    execute,
};
