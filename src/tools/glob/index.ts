import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface GlobArgs {
  readonly pattern: string;
  readonly path?: string;
}

const RESULT_CAP = 200;

const execute = async (
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResult<{ paths: string[]; truncated: boolean }>> => {
  const v = validateArgs<GlobArgs>(rawArgs, GlobTool.schema);
  if (!v.ok) return v;
  const { pattern, path } = v.value;

  const root = path ? (isAbsolute(path) ? path : join(ctx.cwd, path)) : ctx.cwd;
  const glob = new Bun.Glob(pattern);

  const matches: { path: string; mtimeMs: number }[] = [];
  for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
    const abs = join(root, rel);
    try {
      const s = await stat(abs);
      matches.push({ path: abs, mtimeMs: s.mtimeMs });
    } catch {
      // race or permissions — skip
    }
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const truncated = matches.length > RESULT_CAP;
  const paths = (truncated ? matches.slice(0, RESULT_CAP) : matches).map((m) => m.path);
  return { ok: true, value: { paths, truncated } };
};

export const GlobTool: Tool = {
  name: "Glob",
  description:
    "Match files by glob pattern (e.g. `**/*.ts`). Returns absolute paths sorted by mtime descending. " +
    "Search root defaults to cwd; pass `path` to override.",
  annotations: { readOnlyHint: true },
  schema: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
    },
  },
  execute,
};
