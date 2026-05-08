import type { HookEntry, HookEventPayload, HookResult } from "./types.ts";

const DEFAULT_TIMEOUT_SEC = 60;
const OUTPUT_CAP = 32_000;

const truncate = (text: string): string =>
  text.length > OUTPUT_CAP
    ? `${text.slice(0, OUTPUT_CAP)}\n…(truncated, ${text.length - OUTPUT_CAP} more chars)`
    : text;

const runSingle = async (
  entry: HookEntry,
  payload: HookEventPayload,
  signal: AbortSignal,
): Promise<HookResult> => {
  const timeoutSec = entry.timeout ?? DEFAULT_TIMEOUT_SEC;
  const timeoutMs = timeoutSec * 1000;

  const proc = Bun.spawn({
    cmd: ["sh", "-c", entry.command],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: {
      ...process.env,
      YE_EVENT: payload.event,
      ...(payload.tool_name ? { YE_TOOL_NAME: payload.tool_name } : {}),
      ...(payload.file_paths ? { YE_FILE_PATHS: payload.file_paths.join(" ") } : {}),
      YE_PROJECT_DIR: payload.project_dir,
    },
  });

  const stdinPayload = JSON.stringify(payload);
  proc.stdin.write(stdinPayload);
  proc.stdin.end();

  let timedOut = false;
  let aborted = false;

  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(9); } catch { /* already dead */ }
  }, timeoutMs);

  const onAbort = (): void => {
    aborted = true;
    try { proc.kill(9); } catch { /* already dead */ }
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  const [stdoutRaw, stderrRaw] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);

  if (aborted) {
    return { action: "continue", stdout: "", stderr: "" };
  }

  if (timedOut) {
    return {
      action: "continue",
      stdout: "",
      stderr: `hook timed out after ${timeoutSec}s: ${entry.command}`,
    };
  }

  const exitCode = await proc.exited;
  const stdout = truncate(stdoutRaw);
  const stderr = truncate(stderrRaw);

  return {
    action: exitCode === 2 ? "block" : "continue",
    stdout,
    stderr,
  };
};

export const runHooks = async (
  entries: readonly HookEntry[] | undefined,
  payload: HookEventPayload,
  signal: AbortSignal,
): Promise<HookResult | null> => {
  if (!entries || entries.length === 0) return null;

  let combinedStdout = "";
  let combinedStderr = "";

  for (const entry of entries) {
    const result = await runSingle(entry, payload, signal);
    if (result.stdout.length > 0) combinedStdout += (combinedStdout ? "\n" : "") + result.stdout;
    if (result.stderr.length > 0) combinedStderr += (combinedStderr ? "\n" : "") + result.stderr;
    if (result.action === "block") {
      return { action: "block", stdout: combinedStdout, stderr: combinedStderr };
    }
  }

  return { action: "continue", stdout: combinedStdout, stderr: combinedStderr };
};
