import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { killGroupHard } from "../../tools/bash/kill.ts";
import {
    buildInstallCommand,
    buildUninstallCommand,
    checkPrerequisite,
    CATALOGUE,
    defaultRoots,
    defaultWhich,
    entryFor,
    renderCommand,
    type InstallRoots,
    type InstallScope,
    type ServerEntry,
    type Which,
} from "./catalogue.ts";

// Installs are large downloads (gopls builds from source, pyright pulls a node
// tree), so the ceiling is far above the Bash tool's 15 minutes-worth of work.
const INSTALL_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 30_000;
const OUTPUT_CAP = 16_000;

export interface RunRequest {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string;
    readonly timeoutMs: number;
}

export interface RunResult {
    readonly code: number;
    readonly output: string;
    readonly timedOut: boolean;
}

export type Runner = (request: RunRequest, onLine: (line: string) => void) => Promise<RunResult>;

export interface InstallOptions {
    readonly roots?: InstallRoots;
    readonly run?: Runner;
    readonly which?: Which;
    readonly onProgress?: (line: string) => void;
    readonly timeoutMs?: number;
}

export interface InstallResult {
    readonly ok: boolean;
    readonly language: string;
    readonly binary: string;
    readonly path?: string;
    readonly scope: InstallScope;
    readonly output: string;
    readonly error?: string;
}

export interface UninstallResult {
    readonly ok: boolean;
    readonly language: string;
    readonly scope: InstallScope;
    readonly output: string;
    // Set when Ye refuses to run the removal itself.
    readonly manual?: string;
    readonly error?: string;
}

export interface InstalledServer {
    readonly language: string;
    readonly displayName: string;
    readonly binary: string;
    readonly path: string;
    readonly scope: InstallScope;
    readonly source: "ye" | "path";
}

const streamLines = async (
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
    sink: string[],
): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const emit = (line: string): void => {
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
        sink.push(trimmed);
        onLine(trimmed);
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n");
        while (index !== -1) {
            emit(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf("\n");
        }
    }
    if (buffer.length > 0) emit(buffer);
};

export const spawnRunner: Runner = async (request, onLine) => {
    const [command, ...args] = request.argv;
    if (command === undefined) return { code: 1, output: "empty command", timedOut: false };

    const proc = Bun.spawn({
        cmd: [command, ...args],
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        stdout: "pipe",
        stderr: "pipe",
        // New process group: a package manager spawns children of its own, and
        // killing only the parent on timeout leaves the download running.
        detached: process.platform !== "win32",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        killGroupHard(proc);
    }, request.timeoutMs);

    const lines: string[] = [];
    await Promise.all([
        streamLines(proc.stdout, onLine, lines),
        streamLines(proc.stderr, onLine, lines),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);

    return { code, output: lines.join("\n"), timedOut };
};

const capped = (output: string): string =>
    output.length > OUTPUT_CAP ? `…\n${output.slice(output.length - OUTPUT_CAP)}` : output;

const binaryNames = (binary: string): readonly string[] =>
    process.platform === "win32" ? [`${binary}.cmd`, `${binary}.exe`, binary] : [binary];

export interface ResolvedBinary {
    readonly path: string;
    readonly source: "ye" | "path";
}

export const resolveServerBinary = (
    entry: ServerEntry,
    roots: InstallRoots = defaultRoots(),
    which: Which = defaultWhich,
): ResolvedBinary | undefined => {
    for (const dir of [roots.binDir, roots.nodeBinDir]) {
        for (const name of binaryNames(entry.binary)) {
            const candidate = join(dir, name);
            if (existsSync(candidate)) return { path: candidate, source: "ye" };
        }
    }
    // A toolchain install lands wherever the toolchain puts it, never under
    // ~/.ye, so PATH is the only place it can be found.
    if (entry.scope !== "toolchain") return undefined;
    const onPath = which(entry.binary);
    return onPath === null ? undefined : { path: onPath, source: "path" };
};

const isExecutable = (path: string): boolean => {
    if (process.platform === "win32") return true;
    try {
        return (statSync(path).mode & 0o111) !== 0;
    } catch {
        return false;
    }
};

const ensureNodeRoot = (roots: InstallRoots): void => {
    mkdirSync(roots.nodeDir, { recursive: true });
    const manifest = join(roots.nodeDir, "package.json");
    if (existsSync(manifest)) return;
    writeFileSync(
        manifest,
        `${JSON.stringify({ name: "ye-lsp", private: true, version: "0.0.0" }, null, 2)}\n`,
    );
};

const fail = (entry: ServerEntry, output: string, error: string): InstallResult => ({
    ok: false,
    language: entry.language,
    binary: entry.binary,
    scope: entry.scope,
    output,
    error,
});

// An install that exits 0 but leaves no runnable binary is a failure. Reporting
// it as success hands the user a language server that dies on first request.
const verify = async (
    entry: ServerEntry,
    roots: InstallRoots,
    which: Which,
    run: Runner,
    progress: (line: string) => void,
): Promise<
    { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string }
> => {
    const resolved = resolveServerBinary(entry, roots, which);
    if (resolved === undefined) {
        return {
            ok: false,
            error: `install reported success but no \`${entry.binary}\` binary appeared in ${roots.binDir} or ${roots.nodeBinDir}`,
        };
    }

    const probeArgs = entry.probeArgs;
    if (probeArgs === undefined) {
        return isExecutable(resolved.path)
            ? { ok: true, path: resolved.path }
            : { ok: false, error: `${resolved.path} exists but is not executable` };
    }

    progress(`$ ${resolved.path} ${probeArgs.join(" ")}`);
    const probe = await run(
        {
            argv: [resolved.path, ...probeArgs],
            env: {},
            cwd: roots.lspDir,
            timeoutMs: PROBE_TIMEOUT_MS,
        },
        progress,
    );
    if (probe.timedOut)
        return { ok: false, error: `${entry.binary} did not answer its version probe` };
    if (probe.code !== 0) {
        return {
            ok: false,
            error: `${entry.binary} was installed but exited ${probe.code} on \`${probeArgs.join(" ")}\``,
        };
    }
    return { ok: true, path: resolved.path };
};

// Never called by detection, tool execution or startup. The UI calls it only
// after the user has seen installCommandFor(language) and agreed to it.
export const installServer = async (
    language: string,
    opts: InstallOptions = {},
): Promise<InstallResult> => {
    const entry = entryFor(language);
    if (entry === undefined) {
        return {
            ok: false,
            language,
            binary: language,
            scope: "ye",
            output: "",
            error: `no language server in the catalogue for \`${language}\``,
        };
    }

    const roots = opts.roots ?? defaultRoots();
    const which = opts.which ?? defaultWhich;
    const run = opts.run ?? spawnRunner;
    const lines: string[] = [];
    const progress = (line: string): void => {
        lines.push(line);
        opts.onProgress?.(line);
    };

    const prerequisite = checkPrerequisite(entry, which);
    if (!prerequisite.ok) return fail(entry, "", prerequisite.message);

    mkdirSync(roots.binDir, { recursive: true });
    if (entry.install.kind === "node") ensureNodeRoot(roots);

    const command = buildInstallCommand(entry, roots, which);
    progress(`$ ${renderCommand(command)}`);

    const result = await run(
        {
            argv: command.argv,
            env: command.env,
            cwd: command.cwd ?? roots.lspDir,
            timeoutMs: opts.timeoutMs ?? INSTALL_TIMEOUT_MS,
        },
        progress,
    );

    if (result.timedOut) {
        return fail(
            entry,
            capped(lines.join("\n")),
            `install timed out after ${Math.round((opts.timeoutMs ?? INSTALL_TIMEOUT_MS) / 1000)}s`,
        );
    }
    if (result.code !== 0) {
        return fail(entry, capped(lines.join("\n")), `install exited ${result.code}`);
    }

    const verified = await verify(entry, roots, which, run, progress);
    if (!verified.ok) return fail(entry, capped(lines.join("\n")), verified.error);

    return {
        ok: true,
        language: entry.language,
        binary: entry.binary,
        path: verified.path,
        scope: entry.scope,
        output: capped(lines.join("\n")),
    };
};

export const uninstallServer = async (
    language: string,
    opts: InstallOptions = {},
): Promise<UninstallResult> => {
    const entry = entryFor(language);
    if (entry === undefined) {
        return {
            ok: false,
            language,
            scope: "ye",
            output: "",
            error: `no language server in the catalogue for \`${language}\``,
        };
    }

    const roots = opts.roots ?? defaultRoots();
    const which = opts.which ?? defaultWhich;
    const run = opts.run ?? spawnRunner;

    if (entry.scope === "toolchain") {
        const manual = buildUninstallCommand(entry, roots, which);
        return {
            ok: false,
            language: entry.language,
            scope: entry.scope,
            output: "",
            ...(manual !== undefined ? { manual: renderCommand(manual) } : {}),
            error: `${entry.binary} is part of your rustup toolchain, not a file under ~/.ye. Ye will not change a toolchain it does not own — run the command yourself if you want it removed.`,
        };
    }

    const command = buildUninstallCommand(entry, roots, which);
    if (command === undefined) {
        const removed: string[] = [];
        for (const name of binaryNames(entry.binary)) {
            const path = join(roots.binDir, name);
            if (!existsSync(path)) continue;
            rmSync(path, { force: true });
            removed.push(path);
        }
        return {
            ok: true,
            language: entry.language,
            scope: entry.scope,
            output: removed.length > 0 ? `removed ${removed.join(", ")}` : "nothing to remove",
        };
    }

    const prerequisite = checkPrerequisite(entry, which);
    if (!prerequisite.ok) {
        return {
            ok: false,
            language: entry.language,
            scope: entry.scope,
            output: "",
            manual: renderCommand(command),
            error: prerequisite.message,
        };
    }

    const lines: string[] = [];
    const progress = (line: string): void => {
        lines.push(line);
        opts.onProgress?.(line);
    };
    progress(`$ ${renderCommand(command)}`);

    const result = await run(
        {
            argv: command.argv,
            env: command.env,
            cwd: command.cwd ?? roots.lspDir,
            timeoutMs: opts.timeoutMs ?? INSTALL_TIMEOUT_MS,
        },
        progress,
    );

    return result.code === 0 && !result.timedOut
        ? {
              ok: true,
              language: entry.language,
              scope: entry.scope,
              output: capped(lines.join("\n")),
          }
        : {
              ok: false,
              language: entry.language,
              scope: entry.scope,
              output: capped(lines.join("\n")),
              error: result.timedOut ? "uninstall timed out" : `uninstall exited ${result.code}`,
          };
};

export const installedServers = (
    opts: Pick<InstallOptions, "roots" | "which"> = {},
): readonly InstalledServer[] => {
    const roots = opts.roots ?? defaultRoots();
    const which = opts.which ?? defaultWhich;
    return CATALOGUE.flatMap((entry) => {
        const resolved = resolveServerBinary(entry, roots, which);
        return resolved === undefined
            ? []
            : [
                  {
                      language: entry.language,
                      displayName: entry.displayName,
                      binary: entry.binary,
                      path: resolved.path,
                      scope: entry.scope,
                      source: resolved.source,
                  },
              ];
    });
};
