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
            continueSession: false,
            update: false,
            prompt: null,
            mode: null,
            model: null,
            provider: null,
            maxBudgetUsd: null,
            outputFormat: "text",
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

    test("--continue sets its own flag and leaves resume alone", () => {
        const flags = ok(["--continue"]);
        expect(flags.continueSession).toBe(true);
        expect(flags.resume).toBe(false);
        expect(flags.resumeSessionId).toBeNull();
    });

    test("--continue and --resume together are an error in either order", () => {
        const message = "ye: --continue and --resume are mutually exclusive — pick one";
        expect(err(["--continue", "--resume"])).toBe(message);
        expect(err(["--resume", "--continue"])).toBe(message);
        expect(err(["--resume", "abc123", "--continue"])).toBe(message);
    });

    test("--model takes any value — the provider owns the model list", () => {
        expect(ok(["--model", "anthropic/claude-sonnet-4"]).model).toBe(
            "anthropic/claude-sonnet-4",
        );
        expect(ok(["--model", "not-a-real-model"]).model).toBe("not-a-real-model");
    });

    test("--model without a value is an error", () => {
        expect(err(["--model"])).toBe("ye: --model requires a value");
    });

    test("--provider accepts every known id", () => {
        for (const id of ["openrouter", "anthropic", "openai", "deepseek", "ollama"]) {
            expect(ok(["--provider", id]).provider).toBe(id);
        }
    });

    test("--provider rejects missing and unknown values with the valid list", () => {
        expect(err(["--provider"])).toBe(
            "ye: --provider requires openrouter, anthropic, openai, deepseek, ollama",
        );
        expect(err(["--provider", "gemini"])).toBe(
            'ye: unknown provider "gemini" — must be openrouter, anthropic, openai, deepseek, ollama',
        );
        expect(err(["--provider", "OpenAI"])).toContain('unknown provider "OpenAI"');
    });

    test("--max-budget-usd takes a positive number", () => {
        expect(ok(["--max-budget-usd", "2.5"]).maxBudgetUsd).toBe(2.5);
        expect(ok(["--max-budget-usd", "10"]).maxBudgetUsd).toBe(10);
    });

    test("--max-budget-usd rejects missing, zero, negative and non-numeric values", () => {
        expect(err(["--max-budget-usd"])).toBe("ye: --max-budget-usd requires a value");
        expect(err(["--max-budget-usd", "0"])).toContain('invalid --max-budget-usd "0"');
        expect(err(["--max-budget-usd", "-3"])).toContain('invalid --max-budget-usd "-3"');
        expect(err(["--max-budget-usd", "abc"])).toContain('invalid --max-budget-usd "abc"');
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
            continueSession: false,
            update: false,
            prompt: "do a thing",
            mode: "AUTO",
            model: null,
            provider: null,
            maxBudgetUsd: null,
            outputFormat: "text",
            help: false,
            version: false,
        });
    });

    test("--output-format defaults to text and accepts every format", () => {
        expect(ok([]).outputFormat).toBe("text");
        expect(ok(["--output-format", "text"]).outputFormat).toBe("text");
        expect(ok(["--output-format", "json"]).outputFormat).toBe("json");
        expect(ok(["--output-format", "stream-json"]).outputFormat).toBe("stream-json");
    });

    test("--output-format rejects missing and unknown values", () => {
        expect(err(["--output-format"])).toBe(
            "ye: --output-format requires text, json, stream-json",
        );
        expect(err(["--output-format", "yaml"])).toBe(
            'ye: invalid --output-format "yaml" — must be text, json, stream-json',
        );
        expect(err(["--output-format", "JSON"])).toContain('invalid --output-format "JSON"');
    });

    test("help text documents every flag", () => {
        for (const flag of [
            "-p, --prompt",
            "--output-format <fmt>",
            "--mode",
            "--model <id>",
            "--provider <id>",
            "--resume",
            "--continue",
            "--max-budget-usd",
            "--update, --upgrade",
            "-h, --help",
            "-v, --version",
        ]) {
            expect(HELP_TEXT).toContain(flag);
        }
    });

    test("help text documents the stdin form", () => {
        expect(HELP_TEXT).toContain("| ye");
        expect(HELP_TEXT).toContain("read from\nstdin");
    });
});
