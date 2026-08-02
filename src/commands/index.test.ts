import { afterEach, describe, expect, it } from "bun:test";
import {
    getCommand,
    matchCommands,
    parseSlash,
    setExtraCommands,
    setMarkdownCommands,
} from "./index.ts";
import type { SlashCommand } from "./types.ts";

const stub = (name: string, description: string): SlashCommand => ({
    name,
    description,
    execute: () => ({ kind: "ok" }),
});

afterEach(() => {
    setMarkdownCommands([]);
    setExtraCommands([]);
});

describe("parseSlash", () => {
    it("parses a bare command", () => {
        expect(parseSlash("/help")).toEqual({ name: "help", args: "" });
    });

    it("parses arguments", () => {
        expect(parseSlash("/compact focus on auth")).toEqual({
            name: "compact",
            args: "focus on auth",
        });
    });

    it("lowercases the name", () => {
        expect(parseSlash("/HELP")?.name).toBe("help");
    });

    it("accepts a namespaced name", () => {
        expect(parseSlash("/git:sync main")).toEqual({ name: "git:sync", args: "main" });
    });

    it("accepts multiple namespace segments", () => {
        expect(parseSlash("/a:b:c")?.name).toBe("a:b:c");
    });

    it("rejects a trailing or leading colon", () => {
        expect(parseSlash("/git:")).toBeNull();
        expect(parseSlash("/:sync")).toBeNull();
    });

    it("rejects a path-like input", () => {
        expect(parseSlash("/usr/bin/env")).toBeNull();
    });

    it("rejects a name that does not start with a letter", () => {
        expect(parseSlash("/9lives")).toBeNull();
    });

    it("rejects plain text", () => {
        expect(parseSlash("hello")).toBeNull();
    });
});

describe("command precedence", () => {
    it("keeps the built-in when a markdown command shares its name", () => {
        setMarkdownCommands([stub("clear", "markdown clear")]);
        expect(getCommand("clear")?.description).not.toBe("markdown clear");
    });

    it("keeps the built-in when a skill shares its name", () => {
        setExtraCommands([stub("clear", "skill clear")]);
        expect(getCommand("clear")?.description).not.toBe("skill clear");
    });

    it("prefers a markdown command over a skill of the same name", () => {
        setMarkdownCommands([stub("deploy", "markdown deploy")]);
        setExtraCommands([stub("deploy", "skill deploy")]);
        expect(getCommand("deploy")?.description).toBe("markdown deploy");
    });

    it("registers both sources when names do not collide", () => {
        setMarkdownCommands([stub("deploy", "markdown deploy")]);
        setExtraCommands([stub("lint", "skill lint")]);
        expect(getCommand("deploy")?.description).toBe("markdown deploy");
        expect(getCommand("lint")?.description).toBe("skill lint");
    });

    it("matches namespaced markdown commands by prefix", () => {
        setMarkdownCommands([stub("git:sync", "sync it")]);
        expect(matchCommands("/git:").map((c) => c.name)).toEqual(["git:sync"]);
    });
});
