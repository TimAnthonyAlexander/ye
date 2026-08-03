import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { LSP_BIN_DIR, LSP_NODE_BIN_DIR, lspSearchDirs } from "../storage/paths.ts";
import {
    _resetDetectionCache,
    effectiveSettings,
    resetDetectionFor,
    resolveFormat,
    resolveLsp,
    resolveLspBinary,
    resolveVerify,
} from "./detect.ts";
import type { Config } from "./types.ts";

const BASE: Config = {
    defaultProvider: "stub",
    providers: { stub: { baseUrl: "https://example.test", apiKeyEnv: "STUB_KEY" } },
    defaultModel: { provider: "stub", model: "stub-model" },
};

const configWith = (extra: Partial<Config> = {}): Config => ({ ...BASE, ...extra });

let root: string;
let originalPath: string | undefined;

const write = async (name: string, body = ""): Promise<void> => {
    await writeFile(join(root, name), body, "utf8");
};

const packageJson = async (fields: Record<string, unknown>): Promise<void> => {
    await write("package.json", JSON.stringify({ name: "fixture", ...fields }));
};

// A real executable on a real PATH: Bun.which is the gate for every detected
// language server, so faking it any other way would test nothing.
const fakeBinary = async (name: string): Promise<void> => {
    const bin = join(root, "fake-bin");
    await mkdir(bin, { recursive: true });
    const path = join(bin, name);
    await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(path, 0o755);
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
};

// Fixtures written into the user's real ~/.ye/lsp dirs — the constants are the
// thing under test, so pointing them elsewhere would test nothing.
const installed: string[] = [];

const yeInstalled = async (dir: string, name: string, mode = 0o755): Promise<string> => {
    const path = join(dir, name);
    // Never clobber a real install: these are the user's own directories.
    if (existsSync(path)) return path;
    await mkdir(dir, { recursive: true });
    await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(path, mode);
    installed.push(path);
    return path;
};

const emptyPath = async (): Promise<void> => {
    const dir = join(root, "empty-bin");
    await mkdir(dir, { recursive: true });
    process.env.PATH = dir;
};

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ye-detect-test-"));
    originalPath = process.env.PATH;
    _resetDetectionCache();
});

afterEach(async () => {
    process.env.PATH = originalPath;
    _resetDetectionCache();
    for (const path of installed) await rm(path, { force: true });
    installed.length = 0;
    await rm(root, { recursive: true, force: true });
});

describe("verify detection", () => {
    test("AD1 a bare directory detects nothing", () => {
        const verify = resolveVerify(configWith(), root);
        expect(verify.value).toEqual({ enabled: false });
        expect(verify.origins).toEqual({});
    });

    test("AD2 a typecheck script wins over tsconfig and uses the lockfile's package manager", async () => {
        await packageJson({ scripts: { typecheck: "tsc --noEmit", lint: "eslint ." } });
        await write("tsconfig.json", "{}");
        await write("pnpm-lock.yaml");
        const verify = resolveVerify(configWith(), root);
        expect(verify.value.typecheck).toBe("pnpm run typecheck");
        expect(verify.value.lint).toBe("pnpm run lint");
        expect(verify.value.enabled).toBe(true);
        expect(verify.origins["typecheck"]).toBe("detected");
    });

    test("AD3 tsconfig.json alone falls back to the local tsc", async () => {
        await write("tsconfig.json", "{}");
        await write("bun.lock");
        expect(resolveVerify(configWith(), root).value.typecheck).toBe("bunx tsc --noEmit");
    });

    test("AD4 no lockfile defaults to bun", async () => {
        await write("tsconfig.json", "{}");
        expect(resolveVerify(configWith(), root).value.typecheck).toBe("bunx tsc --noEmit");
    });

    test("AD5 Cargo.toml and go.mod get their own toolchain commands", async () => {
        await write("Cargo.toml", "[package]\n");
        expect(resolveVerify(configWith(), root).value.typecheck).toBe("cargo check");

        _resetDetectionCache();
        await rm(join(root, "Cargo.toml"));
        await write("go.mod", "module fixture\n");
        expect(resolveVerify(configWith(), root).value.typecheck).toBe("go build ./...");
    });

    test("AD6 an eslint config detects lint without any package script", async () => {
        await write(".eslintrc.json", "{}");
        await write("yarn.lock");
        const verify = resolveVerify(configWith(), root);
        expect(verify.value.lint).toBe("yarn exec eslint .");
        expect(verify.value.typecheck).toBeUndefined();
        expect(verify.value.enabled).toBe(true);
    });

    test("AD7 biome is the last lint fallback", async () => {
        await write("biome.json", "{}");
        await write("package-lock.json");
        expect(resolveVerify(configWith(), root).value.lint).toBe("npx biome check .");
    });

    test("AD8 test is never detected, even with a test script", async () => {
        await packageJson({ scripts: { test: "bun test", typecheck: "tsc --noEmit" } });
        const verify = resolveVerify(configWith(), root);
        expect(verify.value.test).toBeUndefined();
        expect(verify.origins["test"]).toBeUndefined();
        expect(verify.value.typecheck).toBe("bun run typecheck");
    });

    test("AD9 explicit config beats detection per field", async () => {
        await packageJson({ scripts: { typecheck: "tsc --noEmit", lint: "eslint ." } });
        const verify = resolveVerify(
            configWith({ verify: { lint: "make lint", test: "make test" } }),
            root,
        );
        expect(verify.value.lint).toBe("make lint");
        expect(verify.value.typecheck).toBe("bun run typecheck");
        expect(verify.value.test).toBe("make test");
        expect(verify.origins).toEqual({
            typecheck: "detected",
            lint: "configured",
            test: "configured",
        });
    });

    test("AD10 enabled: false vetoes the whole block", async () => {
        await packageJson({ scripts: { typecheck: "tsc --noEmit", lint: "eslint ." } });
        const verify = resolveVerify(configWith({ verify: { enabled: false } }), root);
        expect(verify.value).toEqual({ enabled: false });
    });

    test("AD11 explicit enabled: true survives with nothing detected", () => {
        const verify = resolveVerify(configWith({ verify: { enabled: true } }), root);
        expect(verify.value.enabled).toBe(true);
        expect(verify.value.typecheck).toBeUndefined();
    });

    test("AD12 timeoutMs is carried through untouched", async () => {
        await write("tsconfig.json", "{}");
        expect(resolveVerify(configWith({ verify: { timeoutMs: 5_000 } }), root).value).toEqual({
            enabled: true,
            typecheck: "bunx tsc --noEmit",
            timeoutMs: 5_000,
        });
    });
});

describe("format detection", () => {
    test("AD13 no formatter config leaves formatting off", async () => {
        await packageJson({ scripts: { typecheck: "tsc --noEmit" } });
        await write("tsconfig.json", "{}");
        expect(resolveFormat(configWith(), root).value).toEqual({ enabled: false });
    });

    test("AD14 a prettier config file turns formatting on", async () => {
        await write(".prettierrc.json", "{}");
        const format = resolveFormat(configWith(), root);
        expect(format.value.enabled).toBe(true);
        const globs = Object.keys(format.value.formatters ?? {});
        expect(globs).toHaveLength(1);
        expect(format.value.formatters?.[globs[0] ?? ""]).toBe("bunx prettier --write $FILE");
        expect(format.origins[globs[0] ?? ""]).toBe("detected");
    });

    test("AD15 .prettierignore alone is not a commitment to prettier", async () => {
        await write(".prettierignore", "dist\n");
        expect(resolveFormat(configWith(), root).value).toEqual({ enabled: false });
    });

    test("AD16 a prettier key in package.json counts", async () => {
        await packageJson({ prettier: { tabWidth: 4 } });
        expect(resolveFormat(configWith(), root).value.enabled).toBe(true);
    });

    test("AD17 biome formats when prettier is absent, and go always gets gofmt", async () => {
        await write("biome.jsonc", "{}");
        await write("go.mod", "module fixture\n");
        const formatters = resolveFormat(configWith(), root).value.formatters ?? {};
        expect(Object.values(formatters)).toContain("bunx biome format --write $FILE");
        expect(formatters["*.go"]).toBe("gofmt -w $FILE");
    });

    test("AD18 the detected glob matches basenames through Bun.Glob", async () => {
        await write(".prettierrc", "{}");
        const glob = Object.keys(resolveFormat(configWith(), root).value.formatters ?? {})[0] ?? "";
        expect(new Bun.Glob(glob).match("a.ts")).toBe(true);
        expect(new Bun.Glob(glob).match("a.tsx")).toBe(true);
        expect(new Bun.Glob(glob).match("a.yaml")).toBe(true);
        expect(new Bun.Glob(glob).match("a.go")).toBe(false);
    });

    test("AD19 explicit formatters replace the detected ones", async () => {
        await write(".prettierrc", "{}");
        const format = resolveFormat(
            configWith({ format: { formatters: { "*.go": "gofmt -w $FILE" } } }),
            root,
        );
        expect(format.value.formatters).toEqual({ "*.go": "gofmt -w $FILE" });
        expect(format.origins["*.go"]).toBe("configured");
    });

    test("AD20 enabled: false vetoes detection", async () => {
        await write(".prettierrc", "{}");
        expect(resolveFormat(configWith({ format: { enabled: false } }), root).value).toEqual({
            enabled: false,
        });
    });
});

describe("lsp detection", () => {
    test("AD21 a language with no server binary on PATH stays off", async () => {
        await write("go.mod", "module fixture\n");
        expect(resolveLsp(configWith(), root).value).toEqual({ enabled: false });
    });

    test("AD22 a server binary plus the language marker turns lsp on", async () => {
        await write("go.mod", "module fixture\n");
        await fakeBinary("gopls");
        const lsp = resolveLsp(configWith(), root);
        expect(lsp.value.enabled).toBe(true);
        expect(lsp.value.servers).toEqual({ go: { command: "gopls" } });
        expect(lsp.origins["go"]).toBe("detected");
    });

    test("AD23 a server binary without the language marker detects nothing", async () => {
        await fakeBinary("gopls");
        expect(resolveLsp(configWith(), root).value).toEqual({ enabled: false });
    });

    test("AD24 configured servers merge over detected ones per language", async () => {
        await write("go.mod", "module fixture\n");
        await fakeBinary("gopls");
        const lsp = resolveLsp(
            configWith({ lsp: { servers: { go: { command: "my-gopls" } } } }),
            root,
        );
        expect(lsp.value.servers).toEqual({ go: { command: "my-gopls" } });
        expect(lsp.origins["go"]).toBe("configured");
    });

    test("AD25 enabled: false vetoes detection", async () => {
        await write("go.mod", "module fixture\n");
        await fakeBinary("gopls");
        expect(resolveLsp(configWith({ lsp: { enabled: false } }), root).value).toEqual({
            enabled: false,
        });
    });
});

describe("Ye-installed server resolution", () => {
    const FIXTURE = "ye-fixture-language-server";

    test("AD32 the search dirs are the Ye install dirs, probed before PATH", () => {
        expect(lspSearchDirs()).toEqual([LSP_BIN_DIR, LSP_NODE_BIN_DIR]);
    });

    test("AD33 a binary in LSP_BIN_DIR resolves to its absolute path", async () => {
        await emptyPath();
        expect(resolveLspBinary(FIXTURE)).toBeUndefined();

        const path = await yeInstalled(LSP_BIN_DIR, FIXTURE);
        const resolved = resolveLspBinary(FIXTURE);
        expect(resolved).toBe(path);
        expect(isAbsolute(resolved ?? "")).toBe(true);
    });

    test("AD34 a symlinked binary in LSP_NODE_BIN_DIR resolves", async () => {
        await emptyPath();
        const target = join(root, "real-server");
        await writeFile(target, "#!/bin/sh\nexit 0\n", "utf8");
        await chmod(target, 0o755);

        const link = join(LSP_NODE_BIN_DIR, FIXTURE);
        await mkdir(LSP_NODE_BIN_DIR, { recursive: true });
        await symlink(target, link);
        installed.push(link);

        expect(resolveLspBinary(FIXTURE)).toBe(link);
    });

    test("AD35 a Ye-installed binary beats a same-named one on PATH", async () => {
        await fakeBinary(FIXTURE);
        expect(resolveLspBinary(FIXTURE)).toBe(join(root, "fake-bin", FIXTURE));

        const path = await yeInstalled(LSP_BIN_DIR, FIXTURE);
        expect(resolveLspBinary(FIXTURE)).toBe(path);
    });

    test("AD36 a file that exists but is not executable is absent, not a spawn crash", async () => {
        await emptyPath();
        await yeInstalled(LSP_BIN_DIR, FIXTURE, 0o644);
        expect(resolveLspBinary(FIXTURE)).toBeUndefined();
    });

    test("AD37 a dangling symlink is absent", async () => {
        await emptyPath();
        const link = join(LSP_BIN_DIR, FIXTURE);
        await mkdir(LSP_BIN_DIR, { recursive: true });
        await symlink(join(root, "gone"), link);
        installed.push(link);

        expect(resolveLspBinary(FIXTURE)).toBeUndefined();
    });

    test("AD38 a command carrying a path separator is passed through untouched", () => {
        expect(resolveLspBinary("/opt/servers/gopls")).toBe("/opt/servers/gopls");
        expect(resolveLspBinary("./gopls")).toBe("./gopls");
    });

    test("AD39 a name found only on PATH still resolves", async () => {
        await fakeBinary(FIXTURE);
        expect(resolveLspBinary(FIXTURE)).toBe(join(root, "fake-bin", FIXTURE));
    });

    test("AD40 detection finds a Ye-installed server with nothing on PATH", async () => {
        await emptyPath();
        await write("go.mod", "module fixture\n");
        expect(resolveLsp(configWith(), root).value).toEqual({ enabled: false });

        await yeInstalled(LSP_BIN_DIR, "gopls");
        resetDetectionFor(root);
        const lsp = resolveLsp(configWith(), root);
        expect(lsp.value.enabled).toBe(true);
        expect(lsp.value.servers).toEqual({ go: { command: "gopls" } });
        expect(lsp.origins["go"]).toBe("detected");
    });

    test("AD41 the vetoes still hold for a Ye-installed server", async () => {
        await emptyPath();
        await write("go.mod", "module fixture\n");
        await yeInstalled(LSP_BIN_DIR, "gopls");
        resetDetectionFor(root);

        expect(resolveLsp(configWith({ lsp: { enabled: false } }), root).value).toEqual({
            enabled: false,
        });
        expect(resolveLsp(configWith({ autoDetect: false }), root).value).toEqual({
            enabled: false,
        });
        expect(
            resolveLsp(configWith({ lsp: { servers: { go: { command: "my-gopls" } } } }), root)
                .value.servers,
        ).toEqual({ go: { command: "my-gopls" } });
    });

    test("AD42 resetDetectionFor only clears the root it is given", async () => {
        await emptyPath();
        await write("go.mod", "module fixture\n");
        expect(resolveLsp(configWith(), root).value.enabled).toBe(false);

        await yeInstalled(LSP_BIN_DIR, "gopls");
        expect(resolveLsp(configWith(), root).value.enabled).toBe(false);

        resetDetectionFor(join(root, "elsewhere"));
        expect(resolveLsp(configWith(), root).value.enabled).toBe(false);

        resetDetectionFor(root);
        expect(resolveLsp(configWith(), root).value.enabled).toBe(true);
    });
});

describe("autoDetect and caching", () => {
    test("AD26 autoDetect: false disables every block", async () => {
        await packageJson({ scripts: { typecheck: "tsc --noEmit", lint: "eslint ." } });
        await write(".prettierrc", "{}");
        await write("go.mod", "module fixture\n");
        await fakeBinary("gopls");
        const config = configWith({ autoDetect: false });
        expect(resolveVerify(config, root).value).toEqual({ enabled: false });
        expect(resolveFormat(config, root).value).toEqual({ enabled: false });
        expect(resolveLsp(config, root).value).toEqual({ enabled: false });
    });

    test("AD27 autoDetect: false still honours explicit config", async () => {
        const config = configWith({ autoDetect: false, verify: { lint: "make lint" } });
        expect(resolveVerify(config, root).value).toEqual({ enabled: true, lint: "make lint" });
    });

    test("AD28 detection is cached per root until the cache is cleared", async () => {
        expect(resolveVerify(configWith(), root).value.typecheck).toBeUndefined();
        await write("tsconfig.json", "{}");
        expect(resolveVerify(configWith(), root).value.typecheck).toBeUndefined();
        _resetDetectionCache();
        expect(resolveVerify(configWith(), root).value.typecheck).toBe("bunx tsc --noEmit");
    });

    test("AD29 a missing directory detects nothing instead of throwing", () => {
        expect(resolveVerify(configWith(), join(root, "does-not-exist")).value).toEqual({
            enabled: false,
        });
    });
});

describe("effectiveSettings", () => {
    test("AD30 every block reports off for a bare project", () => {
        expect(effectiveSettings(configWith(), root)).toEqual([
            { key: "verify", value: "off" },
            { key: "format", value: "off" },
            { key: "lsp", value: "off" },
        ]);
    });

    test("AD31 each value is tagged configured or detected", async () => {
        await packageJson({ scripts: { typecheck: "tsc --noEmit" } });
        const entries = effectiveSettings(configWith({ verify: { test: "bun test" } }), root);
        expect(entries).toContainEqual({
            key: "verify.typecheck",
            value: "bun run typecheck",
            origin: "detected",
        });
        expect(entries).toContainEqual({
            key: "verify.test",
            value: "bun test",
            origin: "configured",
        });
    });
});
