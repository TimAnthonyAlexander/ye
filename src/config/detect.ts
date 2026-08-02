import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, FormatConfig, LspConfig, LspServerConfig, VerifyConfig } from "./types.ts";

export type Origin = "configured" | "detected";

export interface Resolved<T> {
    readonly value: T;
    // Keyed by the field the origin describes: a verify step, a formatter glob,
    // an lsp language. Absent keys were never resolved at all.
    readonly origins: Readonly<Record<string, Origin>>;
}

export interface EffectiveEntry {
    readonly key: string;
    readonly value: string;
    readonly origin?: Origin;
}

type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

interface Detection {
    readonly typecheck?: string;
    readonly lint?: string;
    readonly formatters: Readonly<Record<string, string>>;
    readonly servers: Readonly<Record<string, LspServerConfig>>;
}

const NOTHING: Detection = { formatters: {}, servers: {} };

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
];

const RUN: Readonly<Record<PackageManager, string>> = {
    bun: "bun run",
    pnpm: "pnpm run",
    yarn: "yarn run",
    npm: "npm run",
};

// Runs a binary out of the project's own node_modules/.bin. A bare `tsc` or
// `prettier` is almost never on $PATH even when it is a devDependency.
const EXEC: Readonly<Record<PackageManager, string>> = {
    bun: "bunx",
    pnpm: "pnpm exec",
    yarn: "yarn exec",
    npm: "npx",
};

const ESLINT_CONFIGS: readonly string[] = [".eslintrc", "eslint.config."];
const PRETTIER_CONFIGS: readonly string[] = [".prettierrc", "prettier.config."];

const PRETTIER_GLOB = "*.{ts,tsx,js,jsx,mjs,cjs,json,css,scss,md,yml,yaml}";
const BIOME_GLOB = "*.{ts,tsx,js,jsx,mjs,cjs,json,jsonc,css}";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const readdirSafe = (dir: string): readonly string[] => {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
};

const readJson = (path: string): Record<string, unknown> | undefined => {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
};

const packageManagerFor = (entries: ReadonlySet<string>): PackageManager => {
    for (const [lockfile, manager] of LOCKFILES) {
        if (entries.has(lockfile)) return manager;
    }
    return "bun";
};

// Bun.which resolves against the PATH the process launched with unless one is
// handed to it, and a hook or the user's own env can have changed it since.
const onPath = (binary: string): boolean =>
    Bun.which(binary, { PATH: process.env.PATH ?? "" }) !== null;

const detectServers = (
    has: (name: string) => boolean,
): Readonly<Record<string, LspServerConfig>> => {
    const servers: Record<string, LspServerConfig> = {};
    if ((has("tsconfig.json") || has("package.json")) && onPath("typescript-language-server")) {
        servers["typescript"] = { command: "typescript-language-server", args: ["--stdio"] };
    }
    if (has("go.mod") && onPath("gopls")) {
        servers["go"] = { command: "gopls" };
    }
    if (has("Cargo.toml") && onPath("rust-analyzer")) {
        servers["rust"] = { command: "rust-analyzer" };
    }
    if (has("pyproject.toml") || has("requirements.txt")) {
        if (onPath("pyright-langserver")) {
            servers["python"] = { command: "pyright-langserver", args: ["--stdio"] };
        } else if (onPath("pylsp")) {
            servers["python"] = { command: "pylsp" };
        }
    }
    return servers;
};

const detect = (root: string): Detection => {
    const entries = new Set(readdirSafe(root));
    const has = (name: string): boolean => entries.has(name);
    const hasPrefixed = (prefixes: readonly string[]): boolean =>
        [...entries].some((name) => prefixes.some((prefix) => name.startsWith(prefix)));

    const pkg = has("package.json") ? readJson(join(root, "package.json")) : undefined;
    const scripts = isRecord(pkg?.["scripts"]) ? pkg["scripts"] : {};
    const script = (name: string): boolean => {
        const value = scripts[name];
        return typeof value === "string" && value.trim().length > 0;
    };

    const pm = packageManagerFor(entries);
    const biome = has("biome.json") || has("biome.jsonc");

    const typecheck = script("typecheck")
        ? `${RUN[pm]} typecheck`
        : has("tsconfig.json")
          ? `${EXEC[pm]} tsc --noEmit`
          : has("Cargo.toml")
            ? "cargo check"
            : has("go.mod")
              ? "go build ./..."
              : undefined;

    const lint = script("lint")
        ? `${RUN[pm]} lint`
        : hasPrefixed(ESLINT_CONFIGS)
          ? `${EXEC[pm]} eslint .`
          : biome
            ? `${EXEC[pm]} biome check .`
            : undefined;

    const formatters: Record<string, string> = {};
    // Only a project that has COMMITTED to a formatter gets one. A formatter
    // whose style disagrees with the repo rewrites whole files on every edit
    // and buries the real change in the diff.
    if (hasPrefixed(PRETTIER_CONFIGS) || pkg?.["prettier"] !== undefined) {
        formatters[PRETTIER_GLOB] = `${EXEC[pm]} prettier --write $FILE`;
    } else if (biome) {
        formatters[BIOME_GLOB] = `${EXEC[pm]} biome format --write $FILE`;
    }
    if (has("go.mod")) formatters["*.go"] = "gofmt -w $FILE";

    return {
        ...(typecheck !== undefined ? { typecheck } : {}),
        ...(lint !== undefined ? { lint } : {}),
        formatters,
        servers: detectServers(has),
    };
};

const cache = new Map<string, Detection>();

export const detectProject = (root: string): Detection => {
    const hit = cache.get(root);
    if (hit !== undefined) return hit;
    const fresh = detect(root);
    cache.set(root, fresh);
    return fresh;
};

export const detectLspServers = (root: string): Readonly<Record<string, LspServerConfig>> =>
    detectProject(root).servers;

export const _resetDetectionCache = (): void => {
    cache.clear();
};

const detectionFor = (config: Config, root: string, vetoed: boolean): Detection =>
    vetoed || config.autoDetect === false ? NOTHING : detectProject(root);

export const resolveVerify = (config: Config, root: string): Resolved<VerifyConfig> => {
    const explicit = config.verify;
    const detected = detectionFor(config, root, explicit?.enabled === false);
    const origins: Record<string, Origin> = {};

    const pick = (key: "typecheck" | "lint", fallback: string | undefined): string | undefined => {
        const configured = explicit?.[key];
        if (configured !== undefined) {
            origins[key] = "configured";
            return configured;
        }
        if (fallback !== undefined) origins[key] = "detected";
        return fallback;
    };

    const typecheck = pick("typecheck", detected.typecheck);
    const lint = pick("lint", detected.lint);

    // `test` is never detected. A suite is slow, and one pre-existing failure
    // would trap the model in the verify loop for two extra turns on every
    // chain, forever. It runs only when the user names the command.
    const test = explicit?.test;
    if (test !== undefined) origins["test"] = "configured";

    const enabled =
        explicit?.enabled ?? (typecheck !== undefined || lint !== undefined || test !== undefined);

    return {
        value: {
            enabled,
            ...(typecheck !== undefined ? { typecheck } : {}),
            ...(lint !== undefined ? { lint } : {}),
            ...(test !== undefined ? { test } : {}),
            ...(explicit?.timeoutMs !== undefined ? { timeoutMs: explicit.timeoutMs } : {}),
        },
        origins,
    };
};

export const resolveFormat = (config: Config, root: string): Resolved<FormatConfig> => {
    const explicit = config.format;
    const detected = detectionFor(config, root, explicit?.enabled === false);
    const configured = explicit?.formatters;
    const formatters = configured ?? detected.formatters;
    const origin: Origin = configured !== undefined ? "configured" : "detected";

    const origins: Record<string, Origin> = {};
    for (const glob of Object.keys(formatters)) origins[glob] = origin;
    const any = Object.keys(formatters).length > 0;

    return {
        value: { enabled: explicit?.enabled ?? any, ...(any ? { formatters } : {}) },
        origins,
    };
};

export const resolveLsp = (config: Config, root: string): Resolved<LspConfig> => {
    const explicit = config.lsp;
    const detected = detectionFor(config, root, explicit?.enabled === false);

    const origins: Record<string, Origin> = {};
    const servers: Record<string, LspServerConfig> = {};
    for (const [language, server] of Object.entries(detected.servers)) {
        servers[language] = server;
        origins[language] = "detected";
    }
    for (const [language, server] of Object.entries(explicit?.servers ?? {})) {
        servers[language] = server;
        origins[language] = "configured";
    }
    const any = Object.keys(servers).length > 0;

    return {
        value: { enabled: explicit?.enabled ?? any, ...(any ? { servers } : {}) },
        origins,
    };
};

const serverLine = (server: LspServerConfig): string =>
    [server.command, ...(server.args ?? [])].join(" ");

const block = (
    name: string,
    enabled: boolean | undefined,
    rows: readonly EffectiveEntry[],
): readonly EffectiveEntry[] => {
    if (enabled !== true) return [{ key: name, value: "off" }];
    return rows.length > 0 ? rows : [{ key: name, value: "on, nothing set" }];
};

export const effectiveSettings = (config: Config, root: string): readonly EffectiveEntry[] => {
    const verify = resolveVerify(config, root);
    const format = resolveFormat(config, root);
    const lsp = resolveLsp(config, root);

    const steps = (["typecheck", "lint", "test"] as const).flatMap((step) => {
        const command = verify.value[step];
        return command === undefined
            ? []
            : [{ key: `verify.${step}`, value: command, origin: verify.origins[step] }];
    });

    const globs = Object.entries(format.value.formatters ?? {}).map(([glob, command]) => ({
        key: "format",
        value: `${glob}: ${command}`,
        origin: format.origins[glob],
    }));

    const servers = Object.entries(lsp.value.servers ?? {}).map(([language, server]) => ({
        key: `lsp.${language}`,
        value: serverLine(server),
        origin: lsp.origins[language],
    }));

    return [
        ...block("verify", verify.value.enabled, steps),
        ...block("format", format.value.enabled, globs),
        ...block("lsp", lsp.value.enabled, servers),
    ];
};
