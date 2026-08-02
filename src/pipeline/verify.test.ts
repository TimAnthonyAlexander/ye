import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearVerifyChain,
    formatVerifyReminder,
    MAX_VERIFY_CONTINUATIONS,
    recordToolWrite,
    runVerification,
    shouldVerify,
    useVerifyContinuation,
    verifyContinuationsUsed,
} from "./verify.ts";

let workDir: string;
const signal = (): AbortSignal => new AbortController().signal;

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-verify-test-"));
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("runVerification", () => {
    test("V1 all configured commands pass → passed", async () => {
        const outcome = await runVerification({
            verify: {
                enabled: true,
                typecheck: "exit 0",
                lint: "exit 0",
                test: "exit 0",
            },
            cwd: workDir,
            signal: signal(),
        });
        expect(outcome.kind).toBe("passed");
    });

    test("V2 typecheck failure short-circuits before lint and test", async () => {
        const outcome = await runVerification({
            verify: {
                enabled: true,
                typecheck: "echo tc-broke; exit 1",
                lint: "touch lint-ran",
                test: "touch test-ran",
            },
            cwd: workDir,
            signal: signal(),
        });
        expect(outcome.kind).toBe("failed");
        if (outcome.kind === "failed") {
            expect(outcome.failure.step).toBe("typecheck");
            expect(outcome.failure.timedOut).toBe(false);
            expect(outcome.failure.output).toContain("tc-broke");
        }
        expect(existsSync(join(workDir, "lint-ran"))).toBe(false);
        expect(existsSync(join(workDir, "test-ran"))).toBe(false);
    });

    test("V3 order is typecheck → lint → test, and unconfigured steps are skipped", async () => {
        const outcome = await runVerification({
            verify: { enabled: true, lint: "exit 0", test: "echo tests-broke; exit 3" },
            cwd: workDir,
            signal: signal(),
        });
        expect(outcome.kind).toBe("failed");
        if (outcome.kind === "failed") {
            expect(outcome.failure.step).toBe("test");
            expect(outcome.failure.command).toBe("echo tests-broke; exit 3");
        }
    });

    test("V4 stderr is captured alongside stdout", async () => {
        const outcome = await runVerification({
            verify: { enabled: true, test: "echo out; echo boom 1>&2; exit 1" },
            cwd: workDir,
            signal: signal(),
        });
        expect(outcome.kind).toBe("failed");
        if (outcome.kind === "failed") {
            expect(outcome.failure.output).toContain("out");
            expect(outcome.failure.output).toContain("boom");
        }
    });

    test("V5 long output keeps the tail, not the head", async () => {
        const outcome = await runVerification({
            verify: {
                enabled: true,
                test: "printf 'HEADMARK'; printf 'A%.0s' $(seq 1 6000); printf 'TAILMARK'; exit 1",
            },
            cwd: workDir,
            signal: signal(),
        });
        expect(outcome.kind).toBe("failed");
        if (outcome.kind === "failed") {
            expect(outcome.failure.output).toContain("TAILMARK");
            expect(outcome.failure.output).not.toContain("HEADMARK");
            expect(outcome.failure.output).toContain("truncated");
        }
    });

    test("V6 a command that outruns timeoutMs fails as a timeout, not a test failure", async () => {
        const outcome = await runVerification({
            verify: { enabled: true, test: "sleep 5", timeoutMs: 250 },
            cwd: workDir,
            signal: signal(),
        });
        expect(outcome.kind).toBe("failed");
        if (outcome.kind === "failed") {
            expect(outcome.failure.timedOut).toBe(true);
            expect(outcome.failure.timeoutMs).toBe(250);
            expect(formatVerifyReminder(outcome.failure, false)).toContain("TIMED OUT");
        }
    });

    test("V7 commands run from the given cwd", async () => {
        const outcome = await runVerification({
            verify: { enabled: true, test: "touch marker" },
            cwd: workDir,
            signal: signal(),
        });
        expect(outcome.kind).toBe("passed");
        expect(existsSync(join(workDir, "marker"))).toBe(true);
    });
});

describe("verify chain state", () => {
    const sid = "verify-chain-session";

    afterEach(() => {
        clearVerifyChain(sid);
    });

    test("V8 no writes → shouldVerify is false", () => {
        expect(shouldVerify({ enabled: true, test: "exit 0" }, sid)).toBe(false);
    });

    test("V9 a successful Edit or Write arms verification; other tools do not", () => {
        recordToolWrite(sid, "Read", true);
        expect(shouldVerify({ enabled: true, test: "exit 0" }, sid)).toBe(false);
        recordToolWrite(sid, "Write", false);
        expect(shouldVerify({ enabled: true, test: "exit 0" }, sid)).toBe(false);
        recordToolWrite(sid, "Edit", true);
        expect(shouldVerify({ enabled: true, test: "exit 0" }, sid)).toBe(true);
    });

    test("V10 disabled config or no configured command → no verification", () => {
        recordToolWrite(sid, "Write", true);
        expect(shouldVerify({ enabled: false, test: "exit 0" }, sid)).toBe(false);
        expect(shouldVerify(undefined, sid)).toBe(false);
        expect(shouldVerify({ enabled: true }, sid)).toBe(false);
        expect(shouldVerify({ enabled: true, test: "   " }, sid)).toBe(false);
    });

    test("V11 continuations are capped and reset when the chain is cleared", () => {
        expect(verifyContinuationsUsed(sid)).toBe(0);
        for (let i = 0; i < MAX_VERIFY_CONTINUATIONS; i++) {
            expect(useVerifyContinuation(sid)).toBe(true);
        }
        expect(useVerifyContinuation(sid)).toBe(false);
        expect(verifyContinuationsUsed(sid)).toBe(MAX_VERIFY_CONTINUATIONS);
        clearVerifyChain(sid);
        expect(verifyContinuationsUsed(sid)).toBe(0);
        expect(useVerifyContinuation(sid)).toBe(true);
    });
});

describe("formatVerifyReminder", () => {
    const failure = {
        step: "test" as const,
        command: "bun test",
        timedOut: false,
        timeoutMs: 120_000,
        output: "1 fail",
    };

    test("V12 retryable failure tells the model to fix and finish", () => {
        const text = formatVerifyReminder(failure, false);
        expect(text).toContain("<system-reminder>");
        expect(text).toContain("bun test");
        expect(text).toContain("1 fail");
        expect(text).not.toContain("will not be retried");
    });

    test("V13 final failure says the retries are spent", () => {
        expect(formatVerifyReminder(failure, true)).toContain("will not be retried");
    });
});
