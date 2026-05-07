import { isAbsolute } from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface ReadArgs {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
}

const DEFAULT_LIMIT = 2000;

const execute = async (
  rawArgs: unknown,
  _ctx: ToolContext,
): Promise<ToolResult<{ content: string; totalLines: number }>> => {
  const v = validateArgs<ReadArgs>(rawArgs, ReadTool.schema);
  if (!v.ok) return v;
  const { path, offset = 0, limit = DEFAULT_LIMIT } = v.value;

  if (!isAbsolute(path)) {
    return { ok: false, error: "path must be absolute" };
  }

  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { ok: false, error: `file not found: ${path}` };
  }

  const text = await file.text();
  const allLines = text.split("\n");
  const sliced = allLines.slice(offset, offset + limit);
  const numbered = sliced
    .map((line, i) => `${String(offset + i + 1).padStart(6, " ")}\t${line}`)
    .join("\n");

  _ctx.turnState.readFiles.add(path);

  return {
    ok: true,
    value: { content: numbered, totalLines: allLines.length },
  };
};

export const ReadTool: Tool = {
  name: "Read",
  description:
    "Read a file from disk. Default 2000-line slice. Supports offset/limit. Absolute paths only.",
  annotations: { readOnlyHint: true },
  schema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
      offset: { type: "integer" },
      limit: { type: "integer" },
    },
  },
  execute,
};
