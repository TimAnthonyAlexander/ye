import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, normalizePathArg, toAbsolutePath } from "./paths.ts";

describe("toAbsolutePath", () => {
    test("P1 leaves an absolute path alone", () => {
        expect(toAbsolutePath("/a/b/c.ts", "/proj")).toBe("/a/b/c.ts");
    });

    test("P2 resolves a relative path against cwd", () => {
        expect(toAbsolutePath("src/c.ts", "/proj")).toBe("/proj/src/c.ts");
        expect(toAbsolutePath("./src/c.ts", "/proj")).toBe("/proj/src/c.ts");
        expect(toAbsolutePath("../other/c.ts", "/proj/src")).toBe("/proj/other/c.ts");
    });

    test("P3 expands ~", () => {
        expect(toAbsolutePath("~", "/proj")).toBe(homedir());
        expect(toAbsolutePath("~/.ye/config.json", "/proj")).toBe(
            join(homedir(), ".ye/config.json"),
        );
    });

    test("P4 does not expand ~ inside a name", () => {
        expect(expandHome("~foo/bar")).toBe("~foo/bar");
        expect(toAbsolutePath("~foo/bar", "/proj")).toBe("/proj/~foo/bar");
    });
});

describe("normalizePathArg", () => {
    const call = (name: string, args: unknown) => ({ id: "1", name, args });

    test("P5 rewrites the path arg for path tools", () => {
        const out = normalizePathArg(call("Edit", { path: "src/a.ts", old_string: "x" }), "/proj");
        expect(out.args).toEqual({ path: "/proj/src/a.ts", old_string: "x" });
    });

    test("P6 leaves non-path tools untouched", () => {
        const input = call("Bash", { command: "ls src" });
        expect(normalizePathArg(input, "/proj")).toBe(input);
    });

    test("P7 leaves an absent, empty or already-absolute path untouched", () => {
        const missing = call("Grep", { pattern: "x" });
        expect(normalizePathArg(missing, "/proj")).toBe(missing);
        const empty = call("Read", { path: "" });
        expect(normalizePathArg(empty, "/proj")).toBe(empty);
        const absolute = call("Read", { path: "/proj/a.ts" });
        expect(normalizePathArg(absolute, "/proj")).toBe(absolute);
    });

    test("P8 does not mutate the original call", () => {
        const input = call("Read", { path: "a.ts" });
        const out = normalizePathArg(input, "/proj");
        expect(input.args).toEqual({ path: "a.ts" });
        expect(out.args).toEqual({ path: "/proj/a.ts" });
    });
});
