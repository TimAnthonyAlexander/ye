import { basename } from "node:path";
import { resolveFormat } from "../config/detect.ts";
import { killGroupHard } from "./bash/kill.ts";
import { hashContent } from "./fs.ts";
import type { ToolContext } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const STDERR_CAP = 200;

let timeoutMs = DEFAULT_TIMEOUT_MS;

export const _setFormatTimeoutMs = (ms: number): void => {
    timeoutMs = ms;
};

export const _resetFormatTimeoutMs = (): void => {
    timeoutMs = DEFAULT_TIMEOUT_MS;
};

export interface FormatOutcome {
    // Post-format file contents when the formatter rewrote the file; null when
    // no formatter ran or the file came back byte-identical.
    readonly content: string | null;
    // Single-line note for the tool result. Never an error — see runFormatter.
    readonly note: string | null;
}

const NOTHING: FormatOutcome = { content: null, note: null };

// Mirrors the Bash tool's shell selection: Bun's `sh` does not exist on
// Windows, so the comspec runs the template there.
const shellCommand = (command: string): readonly string[] => {
    if (process.platform === "win32") {
        const comspec = process.env.ComSpec ?? "cmd.exe";
        return [comspec, "/d", "/s", "/c", command];
    }
    return ["sh", "-c", command];
};

const quote = (path: string): string =>
    process.platform === "win32" ? `"${path}"` : `'${path.split("'").join("'\\''")}'`;

const selectTemplate = (
    formatters: Readonly<Record<string, string>>,
    path: string,
): string | null => {
    const name = basename(path);
    for (const [pattern, command] of Object.entries(formatters)) {
        if (new Bun.Glob(pattern).match(name)) return command;
    }
    return null;
};

const buildCommand = (template: string, path: string): string => {
    const quoted = quote(path);
    // split/join rather than replaceAll: `$&`-style sequences in the path would
    // otherwise be read as replacement patterns.
    return template.includes("$FILE")
        ? template.split("$FILE").join(quoted)
        : `${template} ${quoted}`;
};

const oneLine = (text: string): string => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > STDERR_CAP ? `${flat.slice(0, STDERR_CAP)}…` : flat;
};

const failureNote = (timedOut: boolean, exitCode: number, stderr: string): string | null => {
    if (timedOut) {
        return `formatter timed out after ${timeoutMs}ms; the file is written but left unformatted`;
    }
    if (exitCode === 0) return null;
    const detail = oneLine(stderr);
    const suffix = detail === "" ? "" : `: ${detail}`;
    return `formatter exited ${exitCode}; the file is written but left unformatted${suffix}`;
};

// Runs the configured formatter for a file that was just written.
//
// A formatter must NEVER turn a successful Edit/Write into a failure. The
// content is already on disk, so reporting a non-zero formatter exit as a
// failed tool call tells the model its change did not land; it then retries the
// same edit and duplicates the work. Formatter trouble is a note, never an
// error.
export const runFormatter = async (
    path: string,
    written: string,
    ctx: ToolContext,
): Promise<FormatOutcome> => {
    const cfg = resolveFormat(ctx.config, ctx.cwd).value;
    if (cfg.enabled !== true || cfg.formatters === undefined) return NOTHING;
    const template = selectTemplate(cfg.formatters, path);
    if (template === null) return NOTHING;

    const proc = Bun.spawn({
        cmd: [...shellCommand(buildCommand(template, path))],
        cwd: ctx.cwd,
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        killGroupHard(proc);
    }, timeoutMs);

    const [, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    const note = failureNote(timedOut, exitCode, stderr);

    const file = Bun.file(path);
    if (!(await file.exists())) return { content: null, note };
    const after = await file.text();
    if (after === written) return { content: null, note };

    // A formatter that rewrites the file stales the hash Edit/Write just
    // recorded. Without this refresh the model's next Edit to the same path is
    // rejected as external drift.
    ctx.turnState.readFiles.set(path, { hash: hashContent(after) });
    return { content: after, note };
};
