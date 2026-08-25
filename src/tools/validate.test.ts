import { describe, expect, test } from "bun:test";
import { TodoWriteTool } from "./todoWrite/index.ts";
import { validateArgs } from "./validate.ts";

const schema = {
    type: "object",
    required: ["todos"],
    properties: {
        todos: {
            type: "array",
            items: {
                type: "object",
                required: ["content"],
                properties: {
                    content: { type: "string" },
                    status: { type: "string", enum: ["pending", "done"] },
                },
            },
        },
    },
} as const;

describe("validateArgs", () => {
    test("V1 names the keys it did receive when a required one is missing", () => {
        const r = validateArgs({ file_path: "/a.ts" }, { type: "object", required: ["path"] });
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.error).toBe("missing required arg: path (received: file_path)");

        const empty = validateArgs({}, { type: "object", required: ["plan"] });
        expect(empty.ok === false && empty.error).toBe(
            "missing required arg: plan (received none)",
        );
    });

    test("V2 validates array items", () => {
        expect(validateArgs({ todos: [{ content: "a", status: "pending" }] }, schema).ok).toBe(
            true,
        );

        const missing = validateArgs({ todos: [{ content: "a" }, { status: "pending" }] }, schema);
        expect(missing.ok === false && missing.error).toBe(
            "arg todos[1]: missing required arg: content (received: status)",
        );

        const badEnum = validateArgs({ todos: [{ content: "a", status: "nope" }] }, schema);
        expect(badEnum.ok === false && badEnum.error).toBe(
            "arg todos[0]: arg status must be one of: pending, done",
        );

        const badType = validateArgs({ todos: ["a"] }, schema);
        expect(badType.ok === false && badType.error).toBe("arg todos[0]: args must be an object");
    });

    test("V3 accepts Claude Code's todo shape and rejects a bad status", () => {
        const claudeShaped = {
            todos: [{ content: "ship it", status: "in_progress", activeForm: "Shipping it" }],
        };
        expect(validateArgs(claudeShaped, TodoWriteTool.schema).ok).toBe(true);

        const bad = validateArgs(
            { todos: [{ content: "x", status: "doing" }] },
            TodoWriteTool.schema,
        );
        expect(bad.ok).toBe(false);
    });
});
