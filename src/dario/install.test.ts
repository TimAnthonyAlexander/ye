import { describe, expect, test } from "bun:test";
import type { RunRequest, RunResult, Runner } from "../lsp/install/installer.ts";
import {
    DARIO_PACKAGE,
    installCommand,
    installDario,
    isDarioInstalled,
    loginDario,
    probeDario,
    startDarioProxy,
    type Which,
} from "./install.ts";

const whichOf =
    (found: Record<string, string>): Which =>
    (binary) =>
        found[binary] ?? null;

interface Recorded {
    readonly calls: RunRequest[];
    readonly run: Runner;
}

const runnerOf = (results: readonly Partial<RunResult>[]): Recorded => {
    const calls: RunRequest[] = [];
    let index = 0;
    const run: Runner = async (request) => {
        calls.push(request);
        const next = results[index] ?? {};
        index += 1;
        return {
            code: next.code ?? 0,
            output: next.output ?? "",
            timedOut: next.timedOut ?? false,
        };
    };
    return { calls, run };
};

describe("isDarioInstalled", () => {
    test("reads PATH", () => {
        expect(isDarioInstalled(whichOf({ dario: "/usr/local/bin/dario" }))).toBe(true);
        expect(isDarioInstalled(whichOf({}))).toBe(false);
    });
});

describe("installCommand", () => {
    test("prefers npm", () => {
        expect(installCommand(whichOf({ npm: "/n/npm", bun: "/b/bun" }))).toEqual([
            "npm",
            "install",
            "-g",
            DARIO_PACKAGE,
        ]);
    });

    test("falls back to bun when npm is absent", () => {
        expect(installCommand(whichOf({ bun: "/b/bun" }))).toEqual([
            "bun",
            "install",
            "-g",
            DARIO_PACKAGE,
        ]);
    });
});

describe("installDario", () => {
    test("refuses without a package manager", async () => {
        const { run, calls } = runnerOf([]);
        const result = await installDario({ which: whichOf({}), run });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("No node package manager");
        expect(calls).toHaveLength(0);
    });

    test("installs then verifies with --version", async () => {
        const { run, calls } = runnerOf([{}, {}]);
        const result = await installDario({
            which: whichOf({ npm: "/n/npm", dario: "/g/bin/dario" }),
            run,
        });
        expect(result.ok).toBe(true);
        expect(result.path).toBe("/g/bin/dario");
        expect(calls[0]?.argv).toEqual(["npm", "install", "-g", DARIO_PACKAGE]);
        expect(calls[1]?.argv).toEqual(["/g/bin/dario", "--version"]);
    });

    test("a non-zero install is a failure", async () => {
        const { run } = runnerOf([{ code: 1, output: "EACCES" }]);
        const result = await installDario({ which: whichOf({ npm: "/n/npm" }), run });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("exited 1");
    });

    test("a timeout is a failure", async () => {
        const { run } = runnerOf([{ timedOut: true }]);
        const result = await installDario({ which: whichOf({ npm: "/n/npm" }), run });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("timed out");
    });

    test("exit 0 with no binary on PATH is a failure", async () => {
        const { run, calls } = runnerOf([{}]);
        const result = await installDario({ which: whichOf({ npm: "/n/npm" }), run });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("not on PATH");
        expect(calls).toHaveLength(1);
    });

    test("exit 0 with a binary that cannot run is a failure", async () => {
        const { run } = runnerOf([{}, { code: 127, output: "bad interpreter" }]);
        const result = await installDario({
            which: whichOf({ npm: "/n/npm", dario: "/g/bin/dario" }),
            run,
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("--version` exited 127");
    });
});

describe("probeDario", () => {
    const responder = (make: () => Response) => async (): Promise<Response> => make();

    test("200 is running", async () => {
        const result = await probeDario("http://x", {
            fetch: responder(() => new Response("{}", { status: 200 })),
        });
        expect(result.status).toBe("running");
    });

    test("503 is degraded and carries the reason from the body", async () => {
        const body = JSON.stringify({
            oauth: "none",
            expiresIn: "no accounts yet — run `dario accounts add <alias>`",
        });
        const result = await probeDario("http://x", {
            fetch: responder(() => new Response(body, { status: 503 })),
        });
        expect(result.status).toBe("degraded");
        expect(result.detail).toContain("no accounts yet");
    });

    test("503 with an unreadable body is still degraded", async () => {
        const result = await probeDario("http://x", {
            fetch: responder(() => new Response("degraded", { status: 503 })),
        });
        expect(result).toEqual({ status: "degraded" });
    });

    test("a refused connection is unreachable", async () => {
        const result = await probeDario("http://x", {
            fetch: async () => {
                throw new Error("ECONNREFUSED");
            },
        });
        expect(result.status).toBe("unreachable");
    });
});

describe("startDarioProxy", () => {
    test("spawns `dario proxy` by absolute path", () => {
        const spawned: string[][] = [];
        const result = startDarioProxy({
            which: whichOf({ dario: "/g/bin/dario" }),
            spawn: (argv) => void spawned.push([...argv]),
        });
        expect(result.ok).toBe(true);
        expect(spawned).toEqual([["/g/bin/dario", "proxy"]]);
    });

    test("fails when dario is gone", () => {
        const result = startDarioProxy({ which: whichOf({}), spawn: () => {} });
        expect(result.ok).toBe(false);
    });
});

describe("loginDario", () => {
    test("runs `dario login --no-proxy` so it does not block on the daemon", () => {
        const ran: string[][] = [];
        const result = loginDario({
            which: whichOf({ dario: "/g/bin/dario" }),
            foreground: (argv) => {
                ran.push([...argv]);
                return 0;
            },
        });
        expect(result.ok).toBe(true);
        expect(ran).toEqual([["/g/bin/dario", "login", "--no-proxy"]]);
    });

    test("a non-zero exit is a failure", () => {
        const result = loginDario({
            which: whichOf({ dario: "/g/bin/dario" }),
            foreground: () => 1,
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("exited 1");
    });
});
