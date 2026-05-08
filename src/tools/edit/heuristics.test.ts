import { describe, expect, test } from "bun:test";
import { evaluate, type EvaluateInput } from "./heuristics.ts";

const baseInput = (overrides: Partial<EvaluateInput> = {}): EvaluateInput => ({
    original: "before\nafter\n",
    updated: "before\nNEW\nafter\n",
    old_string: "before",
    new_string: "NEW",
    replace_all: false,
    ...overrides,
});

const expectTag = (out: readonly string[], tag: string): void => {
    expect(out.some((m) => m.startsWith(`${tag}:`))).toBe(true);
};

const expectNoTag = (out: readonly string[], tag: string): void => {
    expect(out.some((m) => m.startsWith(`${tag}:`))).toBe(false);
};

describe("evaluate — conflict marker", () => {
    test("fires when new_string contains <<<<<<< at line start", () => {
        const out = evaluate(baseInput({ new_string: "alpha\n<<<<<<< HEAD\nbeta" }));
        expectTag(out, "conflict");
    });
    test("fires for ======= alone on a line", () => {
        const out = evaluate(baseInput({ new_string: "alpha\n=======\nbeta" }));
        expectTag(out, "conflict");
    });
    test("fires for >>>>>>>", () => {
        const out = evaluate(baseInput({ new_string: ">>>>>>> branch\n" }));
        expectTag(out, "conflict");
    });
    test("does not fire when ======= appears mid-line (e.g. comment)", () => {
        const out = evaluate(baseInput({ new_string: "// ====== separator =======" }));
        expectNoTag(out, "conflict");
    });
});

describe("evaluate — stub elision", () => {
    test('fires for "// ..." alone on a line', () => {
        const out = evaluate(baseInput({ new_string: "fn();\n// ...\nfn();" }));
        expectTag(out, "stub");
    });
    test('fires for "// existing code"', () => {
        const out = evaluate(baseInput({ new_string: "fn();\n  // existing code\nfn();" }));
        expectTag(out, "stub");
    });
    test('fires for "// rest unchanged"', () => {
        const out = evaluate(baseInput({ new_string: "fn();\n// rest unchanged\n" }));
        expectTag(out, "stub");
    });
    test('fires for python-style "# ..." alone', () => {
        const out = evaluate(baseInput({ new_string: "fn()\n# ...\nfn()" }));
        expectTag(out, "stub");
    });
    test('fires for "<!-- existing -->"', () => {
        const out = evaluate(baseInput({ new_string: "<div>\n<!-- existing code -->\n</div>" }));
        expectTag(out, "stub");
    });
    test("does NOT fire for legitimate JSX spread `{...props}`", () => {
        const out = evaluate(baseInput({ new_string: "<Foo {...props} />" }));
        expectNoTag(out, "stub");
    });
    test("does NOT fire for legitimate destructuring `const { ...rest } = x`", () => {
        const out = evaluate(baseInput({ new_string: "const { a, ...rest } = obj;" }));
        expectNoTag(out, "stub");
    });
    test("severity-upgraded message when net-line-loss > 50%", () => {
        const longOld = Array(20).fill("real code line").join("\n");
        const out = evaluate(
            baseInput({
                old_string: longOld,
                new_string: "first\n// ...\nlast",
                original: longOld,
                updated: "first\n// ...\nlast",
            }),
        );
        const msg = out.find((m) => m.startsWith("stub:"));
        expect(msg).toBeDefined();
        expect(msg).toContain("<50% the lines");
    });
});

describe("evaluate — CRLF", () => {
    test("fires when LF-only file gets CRLF new_string", () => {
        const out = evaluate(
            baseInput({
                original: "line1\nline2\nline3\n",
                new_string: "added\r\nline\r\n",
            }),
        );
        expectTag(out, "crlf");
    });
    test("fires when CRLF-only file gets LF new_string", () => {
        const out = evaluate(
            baseInput({
                original: "line1\r\nline2\r\nline3\r\n",
                new_string: "added\nline\n",
            }),
        );
        expectTag(out, "crlf");
    });
    test("does not fire when both use LF", () => {
        const out = evaluate(
            baseInput({
                original: "line1\nline2\n",
                new_string: "added\nline\n",
            }),
        );
        expectNoTag(out, "crlf");
    });
    test("does not fire when new_string has no line break", () => {
        const out = evaluate(
            baseInput({
                original: "line1\nline2\n",
                new_string: "single",
            }),
        );
        expectNoTag(out, "crlf");
    });
});

describe("evaluate — noop whitespace-only", () => {
    test("fires when strings differ only in trailing whitespace", () => {
        const out = evaluate(
            baseInput({
                old_string: "hello",
                new_string: "hello   ",
            }),
        );
        expectTag(out, "noop-ws");
    });
    test("fires when strings differ only in leading whitespace", () => {
        const out = evaluate(
            baseInput({
                old_string: "  hello",
                new_string: "hello",
            }),
        );
        expectTag(out, "noop-ws");
    });
    test("does not fire for substantive diff", () => {
        const out = evaluate(
            baseInput({
                old_string: "hello",
                new_string: "world",
            }),
        );
        expectNoTag(out, "noop-ws");
    });
    test("skipped when replace_all=true", () => {
        const out = evaluate(
            baseInput({
                old_string: "hello",
                new_string: "hello   ",
                replace_all: true,
            }),
        );
        expectNoTag(out, "noop-ws");
    });
});

describe("evaluate — dup-block", () => {
    test("fires when new_string repeats a 4-line block within itself", () => {
        const block =
            "function processUserInput(input) {\n    const cleaned = input.trim();\n    const validated = validateInput(cleaned);\n    return validated;\n}";
        const out = evaluate(
            baseInput({
                new_string: `${block}\n\n${block}`,
            }),
        );
        expectTag(out, "dup-block");
    });
    test("fires when across-file: new_string substring now appears 2x in updated, 0 in original", () => {
        const block =
            "// helper that does the validation\nfunction validate(x) {\n    return x !== null && x !== undefined;\n}";
        const original = `function main() {\n    PLACEHOLDER\n}\n${block}\n`;
        const updated = `function main() {\n    ${block}\n}\n${block}\n`;
        const out = evaluate({
            original,
            updated,
            old_string: "PLACEHOLDER",
            new_string: block,
            replace_all: false,
        });
        expectTag(out, "dup-block");
    });
    test("across-file variant skipped when replace_all=true", () => {
        const block =
            "// helper that does the validation\nfunction validate(x) {\n    return x !== null && x !== undefined;\n}";
        const out = evaluate({
            original: "x\nx\nx",
            updated: `${block}\n${block}\n${block}`,
            old_string: "x",
            new_string: block,
            replace_all: true,
        });
        expectNoTag(out, "dup-block");
    });
    test("does not fire for short blocks (under min lines/bytes)", () => {
        const out = evaluate(
            baseInput({
                new_string: "a();\nb();\nc();",
                updated: "a();\nb();\nc();\na();\nb();\nc();",
                original: "",
            }),
        );
        expectNoTag(out, "dup-block");
    });
});

describe("evaluate — indent drift", () => {
    const spacesFile = Array(20).fill("    indented_with_four_spaces();").join("\n");
    const tabsFile = Array(20).fill("\tindented_with_one_tab();").join("\n");

    test("fires when space-dominant file gets tab-indented new_string", () => {
        const out = evaluate({
            original: spacesFile,
            updated: `${spacesFile}\n\tnew_line();`,
            old_string: "x",
            new_string: "\tnew_line();",
            replace_all: false,
        });
        expectTag(out, "indent");
    });
    test("fires when tab-dominant file gets space-indented new_string", () => {
        const out = evaluate({
            original: tabsFile,
            updated: `${tabsFile}\n    new_line();`,
            old_string: "x",
            new_string: "    new_line();",
            replace_all: false,
        });
        expectTag(out, "indent");
    });
    test("does not fire when indentation matches", () => {
        const out = evaluate({
            original: spacesFile,
            updated: `${spacesFile}\n    new_line();`,
            old_string: "x",
            new_string: "    new_line();",
            replace_all: false,
        });
        expectNoTag(out, "indent");
    });
    test("does not fire when file has no clear dominant style", () => {
        const mixed = "    a;\n\tb;\n    c;\n\td;\n    e;\n\tf;";
        const out = evaluate({
            original: mixed,
            updated: `${mixed}\n\tnew_line();`,
            old_string: "x",
            new_string: "\tnew_line();",
            replace_all: false,
        });
        expectNoTag(out, "indent");
    });
    test("skipped when replace_all=true", () => {
        const out = evaluate({
            original: spacesFile,
            updated: spacesFile,
            old_string: "x",
            new_string: "\tnew_line();",
            replace_all: true,
        });
        expectNoTag(out, "indent");
    });
    test("does not fire when file has too few indented lines", () => {
        const out = evaluate({
            original: "top();\nlevel();",
            updated: "top();\nlevel();\n\tindented();",
            old_string: "x",
            new_string: "\tindented();",
            replace_all: false,
        });
        expectNoTag(out, "indent");
    });
});

describe("evaluate — additional stub patterns", () => {
    test('fires for "// keep existing"', () => {
        const out = evaluate(baseInput({ new_string: "fn();\n// keep existing logic\nfn();" }));
        expectTag(out, "stub");
    });
    test('fires for "// (unchanged)"', () => {
        const out = evaluate(baseInput({ new_string: "fn();\n// (unchanged)\nfn();" }));
        expectTag(out, "stub");
    });
    test('fires for "// truncated"', () => {
        const out = evaluate(baseInput({ new_string: "fn();\n// truncated\nfn();" }));
        expectTag(out, "stub");
    });
    test('fires for "# existing code"', () => {
        const out = evaluate(baseInput({ new_string: "fn()\n# existing code\nfn()" }));
        expectTag(out, "stub");
    });
    test('fires for "# rest of"', () => {
        const out = evaluate(baseInput({ new_string: "fn()\n# rest of file\nfn()" }));
        expectTag(out, "stub");
    });
    test('fires for "# truncated"', () => {
        const out = evaluate(baseInput({ new_string: "fn()\n# truncated\nfn()" }));
        expectTag(out, "stub");
    });
    test('fires for "/* ... */" alone on a line', () => {
        const out = evaluate(baseInput({ new_string: "fn();\n/* ... */\nfn();" }));
        expectTag(out, "stub");
    });
    test('fires for "/* existing code */"', () => {
        const out = evaluate(baseInput({ new_string: "fn();\n/* existing code */\nfn();" }));
        expectTag(out, "stub");
    });
});

describe("evaluate — edge cases", () => {
    test("empty new_string (pure deletion) produces no warnings", () => {
        const out = evaluate(
            baseInput({
                original: "alpha\nbeta\ngamma\n",
                updated: "alpha\ngamma\n",
                old_string: "beta\n",
                new_string: "",
            }),
        );
        expect(out).toEqual([]);
    });

    test("file with mixed CRLF/LF endings does not trigger crlf warning", () => {
        const out = evaluate(
            baseInput({
                original: "line1\r\nline2\nline3\r\nline4\n",
                new_string: "added\nline\n",
            }),
        );
        expectNoTag(out, "crlf");
    });

    test("new_string with no leading whitespace does not trigger indent warning", () => {
        const spacesFile = Array(20).fill("    indented_with_four_spaces();").join("\n");
        const out = evaluate({
            original: spacesFile,
            updated: `${spacesFile}\ntop_level();`,
            old_string: "x",
            new_string: "top_level();",
            replace_all: false,
        });
        expectNoTag(out, "indent");
    });

    test("within-newstring repetition below 4-line threshold does not fire dup-block", () => {
        const block =
            "this_is_a_long_function_call_that_exceeds_the_byte_threshold_easily(argument);";
        const out = evaluate(
            baseInput({
                new_string: `${block}\n${block}\n${block}`,
            }),
        );
        expectNoTag(out, "dup-block");
    });

    test("within-newstring repetition with trivial lines does not fire", () => {
        const trivialBlock = "}\n})\n})\n});";
        const out = evaluate(
            baseInput({
                new_string: `${trivialBlock}\n${trivialBlock}`,
            }),
        );
        expectNoTag(out, "dup-block");
    });

    test("conflict marker check is unaffected by replace_all", () => {
        const out = evaluate(
            baseInput({
                new_string: "alpha\n<<<<<<< HEAD\nbeta",
                replace_all: true,
            }),
        );
        expectTag(out, "conflict");
    });

    test("stub check is unaffected by replace_all", () => {
        const out = evaluate(
            baseInput({
                new_string: "fn();\n// ...\nfn();",
                replace_all: true,
            }),
        );
        expectTag(out, "stub");
    });

    test("messages are tagged consistently with prefix:colon format", () => {
        const out = evaluate(
            baseInput({
                new_string: "<<<<<<< HEAD\n// ...\nfoo",
            }),
        );
        for (const m of out) {
            expect(m).toMatch(/^[a-z-]+:\s/);
        }
    });
});

describe("evaluate — output shape", () => {
    test("returns empty array when no heuristics fire", () => {
        const out = evaluate(
            baseInput({
                original: "alpha beta gamma\n",
                updated: "alpha BETA gamma\n",
                old_string: "beta",
                new_string: "BETA",
            }),
        );
        expect(out).toEqual([]);
    });

    test("caps output at 3 messages even when more would fire", () => {
        const longOld = Array(20).fill("original line").join("\n");
        const out = evaluate({
            original: longOld,
            updated: "<<<<<<< HEAD\n// ...\n",
            old_string: longOld,
            new_string: "<<<<<<< HEAD\n// ...\nfoo\r\n",
            replace_all: false,
        });
        expect(out.length).toBeLessThanOrEqual(3);
    });

    test("priority order: conflict before stub before crlf", () => {
        const out = evaluate({
            original: "line1\nline2\n",
            updated: "x",
            old_string: "x",
            new_string: "<<<<<<< HEAD\n// ...\nfoo\r\n",
            replace_all: false,
        });
        expect(out[0]?.startsWith("conflict:")).toBe(true);
        expect(out[1]?.startsWith("stub:")).toBe(true);
        expect(out[2]?.startsWith("crlf:")).toBe(true);
    });

    test("each message ≤ 200 chars", () => {
        const out = evaluate(
            baseInput({
                new_string: "<<<<<<< HEAD\n// ...\nfoo",
            }),
        );
        for (const m of out) expect(m.length).toBeLessThanOrEqual(200);
    });
});
