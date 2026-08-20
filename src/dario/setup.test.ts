import { describe, expect, test } from "bun:test";
import type { OutputSink, PickerPayload } from "../commands/types.ts";
import type { DarioInstallResult, ProbeResult } from "./install.ts";
import { type DarioRuntime, type DarioSurface, ensureDarioReady } from "./setup.ts";

const BASE = "http://localhost:3456";

interface Harness {
    readonly surface: DarioSurface;
    readonly messages: string[];
    readonly titles: string[];
}

const surfaceOf = (answers: readonly (string | null)[]): Harness => {
    const messages: string[] = [];
    const titles: string[] = [];
    let index = 0;
    const sink: OutputSink = { write: (line) => void messages.push(line), close: () => {} };
    return {
        messages,
        titles,
        surface: {
            pick: async (payload: PickerPayload) => {
                titles.push(payload.title);
                const answer = answers[index] ?? null;
                index += 1;
                return answer;
            },
            addSystemMessage: (text) => void messages.push(text),
            streamOutput: () => sink,
            suspendTty: (fn) => fn(),
        },
    };
};

interface RuntimeSpec {
    readonly installed?: boolean;
    readonly install?: DarioInstallResult;
    readonly probes?: readonly ProbeResult[];
}

interface RecordedRuntime {
    readonly rt: DarioRuntime;
    readonly log: string[];
}

const runtimeOf = (spec: RuntimeSpec): RecordedRuntime => {
    const log: string[] = [];
    let installed = spec.installed ?? true;
    const probes = [...(spec.probes ?? [{ status: "running" as const }])];
    return {
        log,
        rt: {
            isInstalled: () => installed,
            installCommand: () => "npm install -g @askalf/dario",
            install: async () => {
                log.push("install");
                const result = spec.install ?? { ok: true, path: "/g/bin/dario", output: "" };
                if (result.ok) installed = true;
                return result;
            },
            probe: async () => {
                log.push("probe");
                return probes.length > 1
                    ? (probes.shift() as ProbeResult)
                    : (probes[0] as ProbeResult);
            },
            startProxy: () => {
                log.push("startProxy");
                return { ok: true };
            },
            login: () => {
                log.push("login");
                return { ok: true };
            },
            sleep: async () => {},
        },
    };
};

describe("ensureDarioReady", () => {
    test("an already-running proxy needs no prompt at all", async () => {
        const { surface, titles } = surfaceOf([]);
        const { rt, log } = runtimeOf({});
        const result = await ensureDarioReady(surface, rt, BASE);
        expect(result).toEqual({ ok: true, note: "dario proxy reachable." });
        expect(titles).toHaveLength(0);
        expect(log).toEqual(["probe"]);
    });

    test("declining the install aborts the switch", async () => {
        const { surface, messages } = surfaceOf(["cancel"]);
        const { rt, log } = runtimeOf({ installed: false });
        const result = await ensureDarioReady(surface, rt, BASE);
        expect(result.ok).toBe(false);
        expect(result.error).toContain("not installed");
        expect(log).toEqual([]);
        expect(messages.join("\n")).toContain("third-party");
    });

    test("the consent text names the command, the scope and the removal", async () => {
        const { surface, messages } = surfaceOf(["cancel"]);
        const { rt } = runtimeOf({ installed: false });
        await ensureDarioReady(surface, rt, BASE);
        const text = messages.join("\n");
        expect(text).toContain("npm install -g @askalf/dario");
        expect(text).toContain("global npm prefix");
        expect(text).toContain("npm uninstall -g @askalf/dario");
    });

    test("a failed install aborts the switch", async () => {
        const { surface } = surfaceOf(["install"]);
        const { rt } = runtimeOf({
            installed: false,
            install: { ok: false, output: "EACCES", error: "npm exited 1" },
        });
        const result = await ensureDarioReady(surface, rt, BASE);
        expect(result.ok).toBe(false);
        expect(result.error).toBe("npm exited 1");
    });

    test("install then start then login is three yeses", async () => {
        const { surface } = surfaceOf(["install", "start", "login"]);
        const { rt, log } = runtimeOf({
            installed: false,
            probes: [{ status: "unreachable" }, { status: "degraded" }, { status: "running" }],
        });
        const result = await ensureDarioReady(surface, rt, BASE);
        expect(result).toEqual({ ok: true, note: "dario proxy reachable." });
        expect(log).toEqual(["install", "probe", "startProxy", "probe", "login", "probe"]);
    });

    test("declining the start still switches, with a hint", async () => {
        const { surface } = surfaceOf(["skip"]);
        const { rt, log } = runtimeOf({ probes: [{ status: "unreachable" }] });
        const result = await ensureDarioReady(surface, rt, BASE);
        expect(result.ok).toBe(true);
        expect(result.note).toContain("dario proxy");
        expect(log).not.toContain("startProxy");
    });

    test("declining the login still switches, and the note carries the reason", async () => {
        const { surface } = surfaceOf(["skip"]);
        const { rt, log } = runtimeOf({
            probes: [{ status: "degraded", detail: "none — no accounts yet" }],
        });
        const result = await ensureDarioReady(surface, rt, BASE);
        expect(result.ok).toBe(true);
        expect(result.note).toContain("no accounts yet");
        expect(result.note).toContain("dario login");
        expect(log).not.toContain("login");
    });

    test("Esc on a picker counts as declining", async () => {
        const { surface } = surfaceOf([null]);
        const { rt } = runtimeOf({ installed: false });
        const result = await ensureDarioReady(surface, rt, BASE);
        expect(result.ok).toBe(false);
    });
});
