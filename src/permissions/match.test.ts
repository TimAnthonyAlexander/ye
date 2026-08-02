import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
    matchesPattern,
    matchPath,
    matchWildcard,
    parsePattern,
    splitCommandSegments,
    subjectOf,
} from "./match.ts";
import type { ToolCall } from "./types.ts";

const call = (name: string, args: unknown = {}): ToolCall => ({ id: "c-1", name, args });
const abs = (p: string): string => resolve(process.cwd(), p);

describe("parsePattern()", () => {
    test("M1 bare tool name → no inner", () => {
        expect(parsePattern("Bash")).toEqual({ tool: "Bash", inner: null });
    });

    test("M2 parenthesised pattern → inner is the raw text", () => {
        expect(parsePattern("Edit(src/**)")).toEqual({ tool: "Edit", inner: "src/**" });
    });

    test("M3 legacy prefix form keeps its `:*` in inner", () => {
        expect(parsePattern("Bash(rm:*)")).toEqual({ tool: "Bash", inner: "rm:*" });
    });

    test("M4 unbalanced parens degrade to an unmatchable tool name", () => {
        expect(parsePattern("Bash(oops")).toEqual({ tool: "Bash(oops", inner: null });
    });

    test("M5 nested parens use the last closer", () => {
        expect(parsePattern("Bash(echo $(date))")).toEqual({
            tool: "Bash",
            inner: "echo $(date)",
        });
    });
});

describe("subjectOf() — deterministic per-tool subject", () => {
    test("M6 Edit takes `path`, not the first string arg", () => {
        const c = call("Edit", {
            old_string: "aaa",
            new_string: "bbb",
            path: "/proj/src/a.ts",
        });
        expect(subjectOf(c)).toEqual({ value: "/proj/src/a.ts", kind: "path" });
    });

    test("M7 Grep takes `path`, not `pattern`", () => {
        const c = call("Grep", { pattern: "TODO", path: "/proj/src" });
        expect(subjectOf(c)).toEqual({ value: "/proj/src", kind: "path" });
    });

    test("M8 Glob/Grep without `path` fall back to cwd", () => {
        expect(subjectOf(call("Glob", { pattern: "**/*.ts" }))).toEqual({
            value: process.cwd(),
            kind: "path",
        });
        expect(subjectOf(call("Grep", { pattern: "TODO" }))).toEqual({
            value: process.cwd(),
            kind: "path",
        });
    });

    test("M9 Bash → command, WebFetch → url, WebSearch → query, Skill → command, Task → kind", () => {
        expect(subjectOf(call("Bash", { command: "ls" }))?.value).toBe("ls");
        expect(subjectOf(call("WebFetch", { url: "https://x.dev/a", prompt: "p" }))?.value).toBe(
            "https://x.dev/a",
        );
        expect(subjectOf(call("WebSearch", { query: "bun glob" }))?.value).toBe("bun glob");
        expect(subjectOf(call("Skill", { command: "init", args: "x" }))?.value).toBe("init");
        expect(subjectOf(call("Task", { kind: "explore", prompt: "find it" }))?.value).toBe(
            "explore",
        );
    });

    test("M10 mapped tool with a missing/non-string subject arg → null", () => {
        expect(subjectOf(call("Read", { offset: 3 }))).toBeNull();
        expect(subjectOf(call("Bash", { command: 12 }))).toBeNull();
    });

    test("M11 unmapped tool falls back to the first string arg", () => {
        const c = call("TodoWrite", { note: "first", other: "second" });
        expect(subjectOf(c)).toEqual({ value: "first", kind: "text" });
    });

    test("M12 unmapped tool with no string args → null", () => {
        expect(subjectOf(call("TodoWrite", { count: 1 }))).toBeNull();
    });
});

describe("matchPath() — glob semantics", () => {
    test("M13 exact match after normalisation", () => {
        expect(matchPath("src/index.ts", abs("src/index.ts"))).toBe(true);
        expect(matchPath("src/index.ts", abs("src/other.ts"))).toBe(false);
    });

    test("M14 `src/**` matches a deep file", () => {
        expect(matchPath("src/**", abs("src/a/b/c.ts"))).toBe(true);
        expect(matchPath("src/**", abs("src/a.ts"))).toBe(true);
    });

    test("M15 `src/**` does not match outside src", () => {
        expect(matchPath("src/**", abs("other/a.ts"))).toBe(false);
        expect(matchPath("src/**", "/etc/passwd")).toBe(false);
    });

    test("M16 `*` does not cross a segment boundary", () => {
        expect(matchPath("src/*", abs("src/a.ts"))).toBe(true);
        expect(matchPath("src/*", abs("src/a/b.ts"))).toBe(false);
    });

    test("M17 `?` matches exactly one character", () => {
        expect(matchPath("src/inde?.ts", abs("src/index.ts"))).toBe(true);
        expect(matchPath("src/inde??.ts", abs("src/index.ts"))).toBe(false);
    });

    test("M18 tilde expands on both sides", () => {
        expect(matchPath("~/.ye/**", join(homedir(), ".ye", "config.json"))).toBe(true);
        expect(matchPath(join(homedir(), ".ye", "config.json"), "~/.ye/config.json")).toBe(true);
        expect(matchPath("~/.ye/**", "/etc/ye/config.json")).toBe(false);
    });

    test("M19 relative rule matches an absolute subject", () => {
        expect(matchPath("src/permissions/**", abs("src/permissions/match.ts"))).toBe(true);
    });

    test("M20 absolute rule matches a relative subject", () => {
        expect(matchPath(abs("src/**"), "src/permissions/match.ts")).toBe(true);
    });

    test("M21 `..` in the subject is normalised before matching", () => {
        expect(matchPath("src/**", abs("src/permissions/../a.ts"))).toBe(true);
        expect(matchPath("src/**", abs("src/../a.ts"))).toBe(false);
    });
});

describe("matchWildcard() — text/command wildcards", () => {
    test("M22 exact string", () => {
        expect(matchWildcard("git status", "git status")).toBe(true);
        expect(matchWildcard("git status", "git status --short")).toBe(false);
    });

    test("M23 trailing and embedded `*`", () => {
        expect(matchWildcard("npm run *", "npm run build")).toBe(true);
        expect(matchWildcard("git * --dry-run", "git push --dry-run")).toBe(true);
        expect(matchWildcard("npm run *", "npm test")).toBe(false);
    });

    test("M24 regex metacharacters in the pattern are literal", () => {
        expect(matchWildcard("echo a.b", "echo a.b")).toBe(true);
        expect(matchWildcard("echo a.b", "echo axb")).toBe(false);
        expect(matchWildcard("echo (x)", "echo (x)")).toBe(true);
    });

    test("M25 `?` matches one character", () => {
        expect(matchWildcard("ls -?", "ls -l")).toBe(true);
        expect(matchWildcard("ls -?", "ls -la")).toBe(false);
    });
});

describe("splitCommandSegments()", () => {
    test("M26 splits on &&, ||, ;, | and newline", () => {
        expect(splitCommandSegments("a && b || c ; d | e\nf")).toEqual([
            "a",
            "b",
            "c",
            "d",
            "e",
            "f",
        ]);
    });

    test("M27 splits on a single backgrounding &", () => {
        expect(splitCommandSegments("git status & rm -rf /")).toEqual(["git status", "rm -rf /"]);
    });

    test("M28 separators inside quotes stay in the segment", () => {
        expect(splitCommandSegments('echo "a && b"')).toEqual(['echo "a && b"']);
        expect(splitCommandSegments("echo 'a; b' | wc")).toEqual(["echo 'a; b'", "wc"]);
    });

    test("M29 escaped quote inside a double-quoted string does not end it", () => {
        expect(splitCommandSegments('echo "a \\" && b"')).toEqual(['echo "a \\" && b"']);
    });

    test("M30 empty and whitespace-only segments are dropped", () => {
        expect(splitCommandSegments("")).toEqual([]);
        expect(splitCommandSegments("  ;  ")).toEqual([]);
        expect(splitCommandSegments("ls &")).toEqual(["ls"]);
    });
});

describe("matchesPattern() — Bash chaining guard", () => {
    const bash = (command: string): ToolCall => call("Bash", { command });

    test("M31 allow requires EVERY segment to match", () => {
        expect(matchesPattern("git status", bash("git status"), "allow")).toBe(true);
        expect(matchesPattern("git status", bash("git status && rm -rf /"), "allow")).toBe(false);
        expect(matchesPattern("git *", bash("git status && git diff"), "allow")).toBe(true);
    });

    test("M32 deny fires on ANY segment", () => {
        expect(matchesPattern("rm *", bash("git status && rm -rf /"), "deny")).toBe(true);
        expect(matchesPattern("rm *", bash("echo hi | rm -rf /"), "deny")).toBe(true);
        expect(matchesPattern("rm *", bash("git status"), "deny")).toBe(false);
    });

    test("M33 legacy prefix obeys the same asymmetry", () => {
        expect(matchesPattern("git:*", bash("git status && rm -rf /"), "allow")).toBe(false);
        expect(matchesPattern("rm:*", bash("git status && rm -rf /"), "deny")).toBe(true);
        expect(matchesPattern("git:*", bash("git status && git diff"), "allow")).toBe(true);
    });

    test("M34 empty command never matches (no vacuous allow)", () => {
        expect(matchesPattern("*", bash(""), "allow")).toBe(false);
        expect(matchesPattern("*", bash("   "), "allow")).toBe(false);
    });

    test("M35 allow refuses a segment carrying command substitution", () => {
        expect(matchesPattern("npm run *", bash("npm run $(rm -rf /)"), "allow")).toBe(false);
        expect(matchesPattern("npm run *", bash("npm run `rm -rf /`"), "allow")).toBe(false);
        expect(matchesPattern("npm run $(*)", bash("npm run $(date)"), "allow")).toBe(true);
    });

    test("M36 non-command subjects are matched whole, not split", () => {
        expect(
            matchesPattern(
                "https://x.dev/*",
                call("WebFetch", { url: "https://x.dev/a|b" }),
                "allow",
            ),
        ).toBe(true);
    });
});
