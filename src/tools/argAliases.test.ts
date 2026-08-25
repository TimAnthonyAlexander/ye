import { describe, expect, test } from "bun:test";
import { applyArgAliases } from "./argAliases.ts";

const call = (name: string, args: unknown) => ({ id: "1", name, args });

describe("applyArgAliases", () => {
    test("A1 folds Claude Code's file_path onto path", () => {
        expect(applyArgAliases(call("Read", { file_path: "/a.ts" })).args).toEqual({
            path: "/a.ts",
        });
        expect(
            applyArgAliases(call("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" }))
                .args,
        ).toEqual({ path: "/a.ts", old_string: "x", new_string: "y" });
        expect(applyArgAliases(call("Write", { file_path: "/a.ts", content: "x" })).args).toEqual({
            path: "/a.ts",
            content: "x",
        });
    });

    test("A2 folds the non-path aliases", () => {
        expect(
            applyArgAliases(call("Task", { subagent_type: "general", prompt: "go" })).args,
        ).toEqual({ kind: "general", prompt: "go" });
        expect(applyArgAliases(call("Skill", { skill: "release" })).args).toEqual({
            command: "release",
        });
        expect(applyArgAliases(call("Grep", { pattern: "todo", "-i": true })).args).toEqual({
            pattern: "todo",
            case_insensitive: true,
        });
        expect(applyArgAliases(call("KillShell", { shell_id: "bash_1" })).args).toEqual({
            bash_id: "bash_1",
        });
        expect(applyArgAliases(call("BashOutput", { task_id: "bash_1" })).args).toEqual({
            bash_id: "bash_1",
        });
    });

    test("A3 leaves a call that already uses our name alone", () => {
        const input = call("Read", { path: "/a.ts" });
        expect(applyArgAliases(input)).toBe(input);
    });

    test("A4 keeps our name when both are present", () => {
        expect(applyArgAliases(call("Read", { path: "/a.ts", file_path: "/b.ts" })).args).toEqual({
            path: "/a.ts",
            file_path: "/b.ts",
        });
    });

    test("A5 applies the first alias only when two map to one name", () => {
        expect(
            applyArgAliases(call("KillShell", { shell_id: "bash_1", task_id: "bash_2" })).args,
        ).toEqual({ bash_id: "bash_1", task_id: "bash_2" });
    });

    test("A6 leaves untabled tools and non-object args alone", () => {
        const bash = call("Bash", { command: "ls" });
        expect(applyArgAliases(bash)).toBe(bash);
        const broken = call("Read", "file_path");
        expect(applyArgAliases(broken)).toBe(broken);
    });

    test("A7 does not mutate the original call", () => {
        const input = call("Read", { file_path: "/a.ts" });
        applyArgAliases(input);
        expect(input.args).toEqual({ file_path: "/a.ts" });
    });
});
