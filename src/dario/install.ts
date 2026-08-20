import { type Runner, spawnRunner } from "../lsp/install/installer.ts";

export const DARIO_PACKAGE = "@askalf/dario";
export const DARIO_BINARY = "dario";

const INSTALL_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 1_500;
const OUTPUT_CAP = 16_000;

export type Which = (binary: string) => string | null;

export const defaultWhich: Which = (binary) =>
    Bun.which(binary, { PATH: process.env["PATH"] ?? "" });

export const isDarioInstalled = (which: Which = defaultWhich): boolean =>
    which(DARIO_BINARY) !== null;

// npm is the documented path and what `dario upgrade` itself runs, so a bun
// install would leave the two package managers fighting over the same binary.
// bun is only the fallback for a machine with no npm at all.
export const installCommand = (which: Which = defaultWhich): readonly string[] =>
    which("npm") !== null
        ? ["npm", "install", "-g", DARIO_PACKAGE]
        : ["bun", "install", "-g", DARIO_PACKAGE];

export const renderInstallCommand = (which: Which = defaultWhich): string =>
    installCommand(which).join(" ");

export interface InstallOptions {
    readonly run?: Runner;
    readonly which?: Which;
    readonly onProgress?: (line: string) => void;
    readonly timeoutMs?: number;
}

export interface DarioInstallResult {
    readonly ok: boolean;
    readonly path?: string;
    readonly output: string;
    readonly error?: string;
}

const capped = (output: string): string =>
    output.length > OUTPUT_CAP ? `…\n${output.slice(output.length - OUTPUT_CAP)}` : output;

export const installDario = async (opts: InstallOptions = {}): Promise<DarioInstallResult> => {
    const which = opts.which ?? defaultWhich;
    const run = opts.run ?? spawnRunner;
    const progress = opts.onProgress ?? ((): void => {});

    if (which("npm") === null && which("bun") === null) {
        return {
            ok: false,
            output: "",
            error: "No node package manager found. Install Node.js (which ships npm) or Bun (https://bun.sh) first.",
        };
    }

    const argv = installCommand(which);
    progress(`$ ${argv.join(" ")}`);
    const result = await run(
        {
            argv,
            env: {},
            cwd: process.cwd(),
            timeoutMs: opts.timeoutMs ?? INSTALL_TIMEOUT_MS,
        },
        progress,
    );

    if (result.timedOut) {
        return { ok: false, output: capped(result.output), error: "install timed out" };
    }
    if (result.code !== 0) {
        return {
            ok: false,
            output: capped(result.output),
            error: `${argv[0]} exited ${result.code}`,
        };
    }

    // A package manager can exit 0 and still leave nothing runnable behind —
    // reporting success there hands the user a provider that dies on first use.
    const path = which(DARIO_BINARY);
    if (path === null) {
        return {
            ok: false,
            output: capped(result.output),
            error: `${DARIO_PACKAGE} installed but \`${DARIO_BINARY}\` is not on PATH`,
        };
    }
    progress(`$ ${DARIO_BINARY} --version`);
    const probe = await run(
        { argv: [path, "--version"], env: {}, cwd: process.cwd(), timeoutMs: PROBE_TIMEOUT_MS },
        progress,
    );
    if (probe.code !== 0) {
        return {
            ok: false,
            output: capped(`${result.output}\n${probe.output}`),
            error: `\`${DARIO_BINARY} --version\` exited ${probe.code}`,
        };
    }

    return { ok: true, path, output: capped(result.output) };
};

export type DarioStatus = "running" | "degraded" | "unreachable";

export interface ProbeResult {
    readonly status: DarioStatus;
    // Rendered from /health's `oauth` + `expiresIn`, which is where dario puts
    // the operator-facing reason ("all tokens expired — run `dario login`").
    readonly detail?: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const readDetail = async (res: Response): Promise<string | undefined> => {
    try {
        const body = (await res.json()) as { oauth?: unknown; expiresIn?: unknown };
        const parts: string[] = [];
        if (typeof body.oauth === "string") parts.push(body.oauth);
        if (typeof body.expiresIn === "string") parts.push(body.expiresIn);
        return parts.length > 0 ? parts.join(" — ") : undefined;
    } catch {
        return undefined;
    }
};

export const probeDario = async (
    baseUrl: string,
    opts: { fetch?: Fetcher; timeoutMs?: number } = {},
): Promise<ProbeResult> => {
    const f = opts.fetch ?? ((url, init) => fetch(url, init));
    try {
        const res = await f(`${baseUrl}/health`, {
            signal: AbortSignal.timeout(opts.timeoutMs ?? HEALTH_TIMEOUT_MS),
        });
        if (res.ok) return { status: "running" };
        const detail = await readDetail(res);
        return detail === undefined ? { status: "degraded" } : { status: "degraded", detail };
    } catch {
        return { status: "unreachable" };
    }
};

export interface SpawnedProxy {
    readonly ok: boolean;
    readonly error?: string;
}

export type DetachedSpawn = (argv: readonly string[]) => void;

const defaultDetachedSpawn: DetachedSpawn = (argv) => {
    const [command, ...args] = argv;
    if (command === undefined) return;
    // Detached and unref'd on purpose: the proxy is a daemon the user also
    // drives from their own shell, so it must outlive this Ye session rather
    // than dying with it.
    const proc = Bun.spawn({
        cmd: [command, ...args],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: process.platform !== "win32",
    });
    proc.unref();
};

export const startDarioProxy = (
    opts: { which?: Which; spawn?: DetachedSpawn } = {},
): SpawnedProxy => {
    const which = opts.which ?? defaultWhich;
    const path = which(DARIO_BINARY);
    if (path === null) return { ok: false, error: `\`${DARIO_BINARY}\` is not on PATH` };
    try {
        (opts.spawn ?? defaultDetachedSpawn)([path, "proxy"]);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
};

// --no-proxy because Ye starts the daemon itself; a bare `dario login` would
// authenticate and then block forever serving the proxy in the foreground.
export const LOGIN_ARGS: readonly string[] = ["login", "--no-proxy"];

export type ForegroundRunner = (argv: readonly string[]) => number | null;

export const defaultForegroundRunner: ForegroundRunner = (argv) => {
    const [command, ...args] = argv;
    if (command === undefined) return null;
    try {
        return Bun.spawnSync({ cmd: [command, ...args], stdio: ["inherit", "inherit", "inherit"] })
            .exitCode;
    } catch {
        return null;
    }
};

export const loginDario = (
    opts: { which?: Which; foreground?: ForegroundRunner } = {},
): { ok: boolean; error?: string } => {
    const which = opts.which ?? defaultWhich;
    const path = which(DARIO_BINARY);
    if (path === null) return { ok: false, error: `\`${DARIO_BINARY}\` is not on PATH` };
    const code = (opts.foreground ?? defaultForegroundRunner)([path, ...LOGIN_ARGS]);
    if (code === null) return { ok: false, error: `could not run \`${DARIO_BINARY} login\`` };
    if (code !== 0) return { ok: false, error: `\`${DARIO_BINARY} login\` exited ${code}` };
    return { ok: true };
};
