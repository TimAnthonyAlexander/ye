import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";

interface BashArgs {
  readonly command: string;
  readonly timeout?: number; // ms
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_CAP = 32_000;

interface BashOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const truncate = (text: string): string =>
  text.length > OUTPUT_CAP
    ? `${text.slice(0, OUTPUT_CAP)}\n…(truncated, ${text.length - OUTPUT_CAP} more chars)`
    : text;

const execute = async (
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResult<BashOutput>> => {
  const v = validateArgs<BashArgs>(rawArgs, BashTool.schema);
  if (!v.ok) return v;
  const command = v.value.command;
  const timeoutMs = Math.min(v.value.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const proc = Bun.spawn({
    cmd: ["sh", "-c", command],
    cwd: ctx.cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: ctx.signal,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    return {
      ok: false,
      error: `command timed out after ${timeoutMs}ms`,
    };
  }

  return {
    ok: true,
    value: {
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      exitCode,
    },
  };
};

export const BashTool: Tool = {
  name: "Bash",
  description:
    "Execute a shell command via `sh -c`. Default 120s timeout, max 600s. " +
    "v1 has NO sandbox: in AUTO mode this command runs immediately with the user's privileges. " +
    "Prefer Read/Edit/Write/Glob/Grep over Bash when they fit.",
  annotations: { readOnlyHint: false },
  schema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string" },
      timeout: { type: "integer" },
    },
  },
  execute,
};
