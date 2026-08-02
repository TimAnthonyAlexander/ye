import { describe, expect, test } from "bun:test";
import { HELP_TEXT, parseFlags, type CliFlags } from "./flags.ts";

const ok = (argv: readonly string[]): CliFlags => {
    const result = parseFlags(argv);
    if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
    return result.flags;
};

const err = (argv: readonly string[]): string => {
    const result = parseFlags(argv);
    if (result.ok) throw new Error("expected error, got ok");
    return result.error;
};

describe("parseFlags", () => {
    test("no arguments", () => {
        expect(ok([])).toEqual({
            resume: false,
            resumeSessionId: null,
            update: false,
            prompt: null,
            mode: null,
            help: false,
            version: false,
        });
    });

    test("positional arguments are ignored", () => {
        expect(ok(["hello world"]).prompt).toBeNull();
    });

    test("--prompt and -p take a value", () => {
        expect(ok(["-p", "hi"]).prompt).toBe("hi");
        expect(ok(["--prompt", "hi"]).prompt).toBe("hi");
    });

    test("-p without a value is an error", () => {
        expect(err(["-p"])).toBe("ye: -p/--prompt requires a value");
        expect(err(["--prompt"])).toBe("ye: -p/--prompt requires a value");
    });

    test("-p value is not parsed as a flag", () => {
        expect(ok(["-p", "--bogus"]).prompt).toBe("--bogus");
    });

    test("--mode uppercases and validates", () => {
        expect(ok(["--mode", "plan"]).mode).toBe("PLAN");
        expect(ok(["--mode", "AUTO"]).mode).toBe("AUTO");
        expect(ok(["--mode", "Normal"]).mode).toBe("NORMAL");
    });

    test("--mode rejects unknown values", () => {
        expect(err(["--mode", "yolo"])).toContain('invalid mode "yolo"');
        expect(err(["--mode"])).toBe("ye: --mode requires AUTO, NORMAL, or PLAN");
    });

    test("--resume without an id", () => {
        const flags = ok(["--resume"]);
        expect(flags.resume).toBe(true);
        expect(flags.resumeSessionId).toBeNull();
    });

    test("--resume with an id", () => {
        const flags = ok(["--resume", "abc123"]);
        expect(flags.resume).toBe(true);
        expect(flags.resumeSessionId).toBe("abc123");
    });

    test("--resume does not swallow a following long flag", () => {
        const flags = ok(["--resume", "--mode", "PLAN"]);
        expect(flags.resume).toBe(true);
        expect(flags.resumeSessionId).toBeNull();
        expect(flags.mode).toBe("PLAN");
    });

    test("--resume does consume a following short flag", () => {
        expect(ok(["--resume", "-p"]).resumeSessionId).toBe("-p");
    });

    test("--update and --upgrade", () => {
        expect(ok(["--update"]).update).toBe(true);
        expect(ok(["--upgrade"]).update).toBe(true);
    });

    test("--help and -h", () => {
        expect(ok(["--help"]).help).toBe(true);
        expect(ok(["-h"]).help).toBe(true);
    });

    test("--version and -v", () => {
        expect(ok(["--version"]).version).toBe(true);
        expect(ok(["-v"]).version).toBe(true);
    });

    test("unknown option is an error", () => {
        expect(err(["--bogus"])).toBe('ye: unknown option "--bogus"\nTry "ye --help" for usage.');
        expect(err(["-x"])).toContain('unknown option "-x"');
    });

    test("unknown option after valid flags is still caught", () => {
        expect(err(["--mode", "PLAN", "--nope"])).toContain('unknown option "--nope"');
    });

    test("combined flags", () => {
        const flags = ok(["--resume", "sess-1", "--mode", "auto", "-p", "do a thing"]);
        expect(flags).toEqual({
            resume: true,
            resumeSessionId: "sess-1",
            update: false,
            prompt: "do a thing",
            mode: "AUTO",
            help: false,
            version: false,
        });
    });

    test("help text documents every flag", () => {
        for (const flag of [
            "-p, --prompt",
            "--mode",
            "--resume",
            "--update, --upgrade",
            "-h, --help",
            "-v, --version",
        ]) {
            expect(HELP_TEXT).toContain(flag);
        }
    });
});
