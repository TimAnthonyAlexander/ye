import { describe, expect, it } from "bun:test";
import { helpLines } from "./help.ts";
import type { SlashCommand } from "./types.ts";

const cmd = (name: string, over: Partial<SlashCommand> = {}): SlashCommand => ({
    name,
    description: `does ${name}`,
    execute: () => ({ kind: "ok" }),
    ...over,
});

describe("helpLines", () => {
    it("lists the commands with their descriptions", () => {
        const text = helpLines([cmd("clear"), cmd("cost")]).join("\n");
        expect(text).toContain("/clear: does clear");
        expect(text).toContain("/cost: does cost");
    });

    it("shows usage and aliases when a command has them", () => {
        const text = helpLines([
            cmd("monitors", { usage: "/monitors [kill <id>]", aliases: ["mon"] }),
        ]).join("\n");
        expect(text).toContain("/monitors — /monitors [kill <id>] (aliases: /mon)");
    });

    it("prints the keybindings the home screen promises", () => {
        const text = helpLines([]).join("\n");
        expect(text).toContain("Keybindings:");
        for (const key of [
            "Enter",
            "Shift+Enter",
            "Tab",
            "Esc",
            "↑ / ↓",
            "Shift+Tab",
            "Ctrl+C",
            "Ctrl+O",
            "Ctrl+R",
            "Ctrl+G",
            "Ctrl+W",
            "!cmd",
            "@",
            "/",
        ]) {
            expect(text).toContain(key);
        }
    });

    it("aligns the keybinding column", () => {
        const lines = helpLines([]);
        const keyLines = lines.slice(lines.indexOf("Keybindings:") + 1);
        const starts = new Set(keyLines.map((line) => line.length - line.trimStart().length));
        expect(starts).toEqual(new Set([2]));
    });
});
