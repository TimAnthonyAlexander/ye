import { killGroupHard } from "../bash/kill.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { validateArgs } from "../validate.ts";
import { filterByPaths, pathNeedles } from "./filter.ts";

type Check = "typecheck" | "lint";

interface DiagnosticsArgs {
    readonly paths?: readonly string[];
    readonly check?: Check;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 32_000;

const EXAMPLE_COMMAND: Readonly<Record<Check, string>> = {
    typecheck: "tsc --noEmit",
    lint: "eslint .",
};

// Truncation keeps the TAIL, unlike Bash/Grep: a checker prints its summary
// ("Found 12 errors in 3 files") last, and the closing diagnostics are what the
// model needs when the output overflows the cap.
const truncateTail = (text: string): string =>
    text.length > OUTPUT_CAP
        ? `…(truncated, ${text.length - OUTPUT_CAP} earlier chars omitted)\n${text.slice(text.length - OUTPUT_CAP)}`
        : text;

const shellCommand = (command: string): readonly string[] =>
    process.platform === "win32"
        ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
        : ["sh", "-c", command];

const attr = (value: string): string => value.replaceAll('"', "&quot;");

const notConfigured = (check: Check): string =>
    `No \`${check}\` command is configured, so there is nothing to run. ` +
    `Set \`verify.${check}\` in ~/.ye/config.json — for example \`{"verify": {"${check}": "${EXAMPLE_COMMAND[check]}"}}\` — and call Diagnostics again. ` +
    `Until then, run the project's own ${check} command with Bash. ` +
    `This is a missing setting, not a failure of your work: nothing you did caused it and re-calling Diagnostics will return the same message.`;

const timeoutMessage = (check: Check, command: string, timeoutMs: number): string =>
    `The ${check} command \`${command}\` timed out after ${timeoutMs}ms and was killed, so there are no results. ` +
    `Raise \`verify.timeoutMs\` in ~/.ye/config.json if the check is genuinely this slow, or run it with Bash using \`run_in_background: true\`. ` +
    `A timeout says nothing about whether the code is correct.`;

const countLines = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length);

const execute = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<string>> => {
    const v = validateArgs<DiagnosticsArgs>(rawArgs, DiagnosticsTool.schema);
    if (!v.ok) return v;
    const check: Check = v.value.check ?? "typecheck";
    const paths = v.value.paths;
    if (paths !== undefined && paths.some((p) => typeof p !== "string" || p.length === 0)) {
        return { ok: false, error: "arg paths must be an array of non-empty strings" };
    }

    const verify = ctx.config.verify;
    const command = verify?.[check];
    if (command === undefined) return { ok: false, error: notConfigured(check) };
    const timeoutMs = verify?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const startedAt = performance.now();
    const proc = Bun.spawn({
        cmd: [...shellCommand(command)],
        cwd: ctx.cwd,
        stdout: "pipe",
        stderr: "pipe",
        // New process group so a check that spawns workers (jest, tsc --build)
        // dies whole on timeout instead of orphaning children. POSIX only — on
        // Windows `detached` opens a separate console and loses piped output.
        detached: process.platform !== "win32",
    });

    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
        timedOut = true;
        killGroupHard(proc);
    }, timeoutMs);
    const onAbort = (): void => {
        aborted = true;
        killGroupHard(proc);
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });

    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);

    if (aborted) return { ok: false, error: "diagnostics aborted by user (Ctrl+C)" };
    if (timedOut) return { ok: false, error: timeoutMessage(check, command, timeoutMs) };

    const durationMs = Math.round(performance.now() - startedAt);
    // stdout and stderr are merged into one stream: checkers split diagnostics
    // across the two inconsistently (tsc writes to stdout, many linters to
    // stderr), and the model wants a single ordered list either way.
    const combined = [stdout, stderr]
        .filter((s) => s.trim().length > 0)
        .join("\n")
        .trim();

    const needles = paths && paths.length > 0 ? pathNeedles(paths, ctx.cwd) : undefined;
    const filtered = needles ? filterByPaths(combined, needles) : combined;
    const dropped = needles ? countLines(combined) - countLines(filtered) : 0;

    let body: string;
    if (filtered.length > 0) {
        const note =
            dropped > 0
                ? `\n(${dropped} line(s) about other files were filtered out by \`paths\`)`
                : "";
        body = `${truncateTail(filtered)}${note}`;
    } else if (needles && combined.length > 0) {
        body = `(no diagnostics for the requested paths — ${dropped} line(s) of output about other files were filtered out)`;
    } else {
        body = `(no diagnostics — the ${check} command reported nothing)`;
    }

    const pathsAttr = paths && paths.length > 0 ? ` paths="${attr(paths.join(", "))}"` : "";
    return {
        ok: true,
        value:
            `<diagnostics check="${check}" exit_code="${exitCode}" duration_ms="${durationMs}" command="${attr(command)}"${pathsAttr}>\n` +
            `${body}\n</diagnostics>`,
    };
};

export const DiagnosticsTool: Tool = {
    name: "Diagnostics",
    description:
        "Runs the project's configured typecheck or lint command and reports the diagnostics it produced — real compiler/linter output, not a guess. " +
        '`check` picks the command: "typecheck" (default) or "lint". Both come from the user\'s own `verify` config; a check with no command configured returns a message naming the config key to set. ' +
        "`paths` FILTERS THE REPORTED LINES — it does not scope the command. The whole configured check always runs (a typechecker needs the full program for cross-file inference), then only lines mentioning those paths are reported. " +
        "Omit `paths` to see everything, which includes pre-existing problems in files you never touched. " +
        "An empty result means NO DIAGNOSTICS: the check is clean, there is nothing to fix and nothing to re-run. " +
        "Diagnostics appearing after an edit do NOT mean the edit failed — the edit already applied. Read them, fix what they actually say, and never re-apply the same edit just because output appeared.",
    // Read-only despite spawning a process: the model chooses only which check
    // to run and which paths to report, never the command itself, which comes
    // from the user's config. There is no injection surface to gate on.
    annotations: { readOnlyHint: true },
    schema: {
        type: "object",
        properties: {
            paths: { type: "array" },
            check: { type: "string", enum: ["typecheck", "lint"] },
        },
    },
    execute,
};
