import { isAbsolute, join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import { grepFallback } from "./fallback.ts";

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

// Bun throws synchronously when the binary isn't on PATH. The message looks
// like: Executable not found in $PATH: "rg". Windows installs often lack rg, so
// detect this and switch to the pure-Bun fallback instead of failing the tool.
const isMissingRipgrep = (e: unknown): boolean =>
    e instanceof Error && /not found|ENOENT/i.test(e.message);

const runRipgrep = async (
    pattern: string,
    path: string,
    mode: GrepMode,
    type: string | undefined,
    glob: string | undefined,
    ctx: ToolContext,
): Promise<{ stdout: string; exitCode: number }> => {
    const args = ["rg", "--no-heading", "--color", "never", ...flagsForMode(mode)];
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
        throw new Error(stderr.trim() || `rg exited with code ${exitCode}`);
    }
    return { stdout, exitCode };
};

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<GrepArgs>(rawArgs, GrepTool.schema);
    if (!v.ok) return v;
    const { pattern, path = ctx.cwd, output_mode = "content", type, glob } = v.value;

    let stdout: string;
    let exitCode: number;
    try {
        ({ stdout, exitCode } = await runRipgrep(pattern, path, output_mode, type, glob, ctx));
    } catch (e) {
        if (!isMissingRipgrep(e)) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        const root = isAbsolute(path) ? path : join(ctx.cwd, path);
        try {
            stdout = await grepFallback({
                pattern,
                root,
                mode: output_mode,
                type,
                glob,
                signal: ctx.signal,
            });
        } catch (fe) {
            return { ok: false, error: fe instanceof Error ? fe.message : String(fe) };
        }
        // Mirror ripgrep's exit semantics: 0 = matched, 1 = no match.
        exitCode = stdout.length > 0 ? 0 : 1;
    }

    const output = truncate(stdout);
    const header = `<grep exit_code="${exitCode}">`;
    return { ok: true, value: output.length > 0 ? `${header}\n${output}` : header };
};

export const GrepTool: Tool = {
    name: "Grep",
    description:
        "Search file contents using ripgrep (falls back to a built-in scanner when `rg` is not installed). " +
        "Modes: content (matching lines, default), " +
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
