import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    CATALOGUE,
    entryFor,
    installCommandFor,
    rootsAt,
    type InstallRoots,
    type Which,
} from "./catalogue.ts";
import {
    installedServers,
    installServer,
    spawnRunner,
    uninstallServer,
    type RunRequest,
    type Runner,
    type RunResult,
} from "./installer.ts";

const whichOf =
    (...available: readonly string[]): Which =>
    (binary) =>
        available.includes(binary) ? `/usr/bin/${binary}` : null;

interface Recorder {
    readonly calls: RunRequest[];
    readonly run: Runner;
}

const recorder = (handler: (request: RunRequest) => Partial<RunResult> = () => ({})): Recorder => {
    const calls: RunRequest[] = [];
    const run: Runner = async (request) => {
        calls.push(request);
        return { code: 0, output: "", timedOut: false, ...handler(request) };
    };
    return { calls, run };
};

const stub = (path: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
};

let dir: string;
let roots: InstallRoots;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ye-lsp-install-"));
    roots = rootsAt(dir);
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("catalogue", () => {
    test("I1 every entry declares a language, binary, markers and a scope", () => {
        expect(CATALOGUE.map((entry) => entry.language)).toEqual([
            "typescript",
            "python",
            "go",
            "rust",
        ]);
        for (const entry of CATALOGUE) {
            expect(entry.binary.length).toBeGreaterThan(0);
            expect(entry.markers.length).toBeGreaterThan(0);
            expect(entry.prerequisite.anyOf.length).toBeGreaterThan(0);
            expect(entry.uninstall.length).toBeGreaterThan(0);
        }
    });

    test("I2 rust is the only toolchain-scoped entry and says so in its uninstall text", () => {
        const toolchain = CATALOGUE.filter((entry) => entry.scope === "toolchain");
        expect(toolchain.map((entry) => entry.language)).toEqual(["rust"]);
        expect(entryFor("rust")?.uninstall).toContain("rustup component remove rust-analyzer");
    });

    test("I3 no entry can ever need sudo", () => {
        for (const entry of CATALOGUE) {
            const shown = installCommandFor(entry.language, { roots, which: whichOf("bun") });
            expect(shown).not.toContain("sudo");
        }
    });
});

describe("command construction", () => {
    test("I4 typescript installs both packages into Ye's private node root with bun", async () => {
        const { calls, run } = recorder();
        await installServer("typescript", { roots, run, which: whichOf("bun") });

        const install = calls[0];
        expect(install?.argv).toEqual(["bun", "add", "typescript-language-server", "typescript"]);
        expect(install?.cwd).toBe(roots.nodeDir);
        expect(install?.env).toEqual({});
    });

    test("I5 without bun the node install falls back to npm with --prefix", async () => {
        const { calls, run } = recorder();
        await installServer("python", { roots, run, which: whichOf("npm") });

        expect(calls[0]?.argv).toEqual(["npm", "install", "--prefix", roots.nodeDir, "pyright"]);
    });

    test("I6 a node install is never global", async () => {
        for (const tool of ["bun", "npm"] as const) {
            const { calls, run } = recorder();
            await installServer("typescript", { roots, run, which: whichOf(tool) });
            const argv = calls[0]?.argv ?? [];
            expect(argv).not.toContain("-g");
            expect(argv).not.toContain("--global");
            expect(calls[0]?.cwd).toBe(roots.nodeDir);
        }
    });

    test("I7 a node install bootstraps a private package.json once", async () => {
        const { run } = recorder();
        await installServer("typescript", { roots, run, which: whichOf("bun") });

        const manifest = join(roots.nodeDir, "package.json");
        expect(existsSync(manifest)).toBe(true);
        const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
        expect(parsed).toMatchObject({ name: "ye-lsp", private: true });
    });

    test("I8 go installs with GOBIN pointed at Ye's bin dir", async () => {
        const { calls, run } = recorder();
        await installServer("go", { roots, run, which: whichOf("go") });

        expect(calls[0]?.argv).toEqual(["go", "install", "golang.org/x/tools/gopls@latest"]);
        expect(calls[0]?.env).toEqual({ GOBIN: roots.binDir });
    });

    test("I9 rust installs through rustup, unscoped to ~/.ye", async () => {
        const { calls, run } = recorder();
        const result = await installServer("rust", { roots, run, which: whichOf("rustup") });

        expect(calls[0]?.argv).toEqual(["rustup", "component", "add", "rust-analyzer"]);
        expect(result.scope).toBe("toolchain");
    });

    test("I10 installCommandFor is exactly what gets spawned", async () => {
        for (const [language, tool] of [
            ["typescript", "bun"],
            ["python", "npm"],
            ["go", "go"],
            ["rust", "rustup"],
        ] as const) {
            const which = whichOf(tool);
            const { calls, run } = recorder();
            await installServer(language, { roots, run, which });

            const shown = installCommandFor(language, { roots, which }) ?? "";
            const spawned = calls[0];
            expect(shown).toContain((spawned?.argv ?? []).join(" "));
            for (const [key, value] of Object.entries(spawned?.env ?? {})) {
                expect(shown).toContain(`${key}=${value}`);
            }
        }
    });

    test("I11 an unknown language is refused without spawning anything", async () => {
        const { calls, run } = recorder();
        const result = await installServer("cobol", { roots, run, which: whichOf("bun") });

        expect(result.ok).toBe(false);
        expect(result.error).toContain("cobol");
        expect(calls).toEqual([]);
    });
});

describe("prerequisites", () => {
    test("I12 a missing toolchain refuses and names what to install first", async () => {
        const { calls, run } = recorder();
        const result = await installServer("go", { roots, run, which: whichOf() });

        expect(result.ok).toBe(false);
        expect(result.error).toContain("go.dev");
        expect(calls).toEqual([]);
    });

    test("I13 a missing node package manager names both bun and npm", async () => {
        const { calls, run } = recorder();
        const result = await installServer("typescript", { roots, run, which: whichOf() });

        expect(result.ok).toBe(false);
        expect(result.error).toContain("Bun");
        expect(result.error).toContain("npm");
        expect(calls).toEqual([]);
    });
});

describe("verification", () => {
    test("I14 a successful install verifies the binary and reports its path", async () => {
        const binary = join(roots.nodeBinDir, "typescript-language-server");
        const { calls, run } = recorder((request) => {
            if (request.argv[0] === "bun") stub(binary);
            return {};
        });

        const result = await installServer("typescript", { roots, run, which: whichOf("bun") });

        expect(result.ok).toBe(true);
        expect(result.path).toBe(binary);
        expect(calls[1]?.argv).toEqual([binary, "--version"]);
    });

    test("I15 exit 0 with no binary is a failure, not a success", async () => {
        const { run } = recorder();
        const result = await installServer("typescript", { roots, run, which: whichOf("bun") });

        expect(result.ok).toBe(false);
        expect(result.error).toContain("typescript-language-server");
        expect(result.error).toContain(roots.nodeBinDir);
    });

    test("I16 a binary that fails its version probe is a failure", async () => {
        const binary = join(roots.binDir, "gopls");
        const { run } = recorder((request) => {
            if (request.argv[0] === "go") {
                stub(binary);
                return {};
            }
            return { code: 3, output: "boom" };
        });

        const result = await installServer("go", { roots, run, which: whichOf("go") });

        expect(result.ok).toBe(false);
        expect(result.error).toContain("exited 3");
    });

    test("I17 a nonzero install exit is reported with its output", async () => {
        const { run } = recorder(() => ({ code: 1 }));
        const result = await installServer("go", {
            roots,
            run,
            which: whichOf("go"),
            onProgress: () => {},
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain("exited 1");
        expect(result.output).toContain("go install");
    });

    test("I18 a timeout is reported as a timeout", async () => {
        const { run } = recorder(() => ({ timedOut: true }));
        const result = await installServer("go", {
            roots,
            run,
            which: whichOf("go"),
            timeoutMs: 1_000,
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain("timed out");
    });

    test("I19 progress lines stream out as they arrive", async () => {
        const seen: string[] = [];
        const run: Runner = async (request, onLine) => {
            onLine(`running ${request.argv[0]}`);
            return { code: 0, output: "", timedOut: false };
        };
        await installServer("go", {
            roots,
            run,
            which: whichOf("go"),
            onProgress: (l) => seen.push(l),
        });

        expect(seen[0]).toContain("go install");
        expect(seen).toContain("running go");
    });
});

describe("the default runner", () => {
    test("I25 streams output lines and returns the exit code", async () => {
        const seen: string[] = [];
        const result = await spawnRunner(
            { argv: [process.execPath, "--version"], env: {}, cwd: dir, timeoutMs: 30_000 },
            (line) => seen.push(line),
        );

        expect(result.code).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(seen.length).toBeGreaterThan(0);
    });

    test("I26 kills a command that outlives its timeout", async () => {
        const result = await spawnRunner(
            {
                argv: [process.execPath, "-e", "await Bun.sleep(30000)"],
                env: {},
                cwd: dir,
                timeoutMs: 200,
            },
            () => {},
        );

        expect(result.timedOut).toBe(true);
    });
});

describe("uninstall", () => {
    test("I20 a toolchain server is never removed by Ye, only explained", async () => {
        const { calls, run } = recorder();
        const result = await uninstallServer("rust", { roots, run, which: whichOf("rustup") });

        expect(result.ok).toBe(false);
        expect(result.scope).toBe("toolchain");
        expect(result.manual).toBe("rustup component remove rust-analyzer");
        expect(result.error).toContain("toolchain");
        expect(calls).toEqual([]);
    });

    test("I21 go's binary is deleted from Ye's bin dir", async () => {
        const binary = join(roots.binDir, "gopls");
        stub(binary);

        const { calls, run } = recorder();
        const result = await uninstallServer("go", { roots, run, which: whichOf("go") });

        expect(result.ok).toBe(true);
        expect(existsSync(binary)).toBe(false);
        expect(calls).toEqual([]);
    });

    test("I22 a node server is removed with the package manager, locally", async () => {
        const { calls, run } = recorder();
        const result = await uninstallServer("python", { roots, run, which: whichOf("bun") });

        expect(result.ok).toBe(true);
        expect(calls[0]?.argv).toEqual(["bun", "remove", "pyright"]);
        expect(calls[0]?.cwd).toBe(roots.nodeDir);
    });
});

describe("installedServers", () => {
    test("I23 only servers with a real binary under Ye's dirs are listed", () => {
        stub(join(roots.nodeBinDir, "pyright-langserver"));
        stub(join(roots.binDir, "gopls"));

        const installed = installedServers({ roots, which: whichOf() });

        expect(installed.map((server) => server.language)).toEqual(["python", "go"]);
        expect(installed.every((server) => server.source === "ye")).toBe(true);
    });

    test("I24 a toolchain server is found on PATH, a ye-scoped one is not", () => {
        const installed = installedServers({
            roots,
            which: whichOf("rust-analyzer", "typescript-language-server"),
        });

        expect(installed.map((server) => server.language)).toEqual(["rust"]);
        expect(installed[0]?.source).toBe("path");
        expect(installed[0]?.scope).toBe("toolchain");
    });
});
