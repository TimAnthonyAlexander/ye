import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMarkdownCommands, parseMarkdownCommandFile } from "./markdown.ts";
import type { SlashCommand, SlashCommandContext } from "./types.ts";

let root = "";
let userDir = "";
const sent: string[] = [];

const ctx = {
    sendHiddenPrompt: (prompt: string) => {
        sent.push(prompt);
    },
} as unknown as SlashCommandContext;

const write = async (path: string, content: string): Promise<void> => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
};

const byName = (cmds: readonly SlashCommand[], name: string): SlashCommand | undefined =>
    cmds.find((c) => c.name === name);

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ye-md-project-"));
    userDir = await mkdtemp(join(tmpdir(), "ye-md-user-"));
    const projectDir = join(root, ".ye", "commands");

    await write(join(projectDir, "review.md"), "Review the diff in $ARGUMENTS carefully.");
    await write(
        join(projectDir, "ship.md"),
        ["---", "description: Ship it", "argument-hint: <version>", "---", "", "Ship $0 now."].join(
            "\n",
        ),
    );
    await write(join(projectDir, "git", "sync.md"), "Sync branch $0 onto $1.");
    await write(join(projectDir, "shared.md"), "project body");
    await write(join(projectDir, "notes.txt"), "not a command");
    await write(join(projectDir, "9bad.md"), "unreachable name");

    await write(join(userDir, "shared.md"), "user body");
    await write(join(userDir, "personal.md"), "personal body");
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
});

describe("parseMarkdownCommandFile", () => {
    it("treats a file without frontmatter as pure body", () => {
        const parsed = parseMarkdownCommandFile("just the body\n");
        expect(parsed.description).toBeNull();
        expect(parsed.argumentHint).toBeNull();
        expect(parsed.body).toBe("just the body");
    });

    it("reads description and argument-hint", () => {
        const parsed = parseMarkdownCommandFile(
            ["---", "description: Do a thing", "argument-hint: <path>", "---", "", "body"].join(
                "\n",
            ),
        );
        expect(parsed.description).toBe("Do a thing");
        expect(parsed.argumentHint).toBe("<path>");
        expect(parsed.body).toBe("body");
    });

    it("keeps the body when the closing delimiter is missing", () => {
        const parsed = parseMarkdownCommandFile("---\ndescription: x\nbody without close");
        expect(parsed.description).toBeNull();
        expect(parsed.body).toBe("---\ndescription: x\nbody without close");
    });
});

describe("loadMarkdownCommands", () => {
    it("names commands after the file", async () => {
        const cmds = await loadMarkdownCommands({ projectRoot: root, userDir });
        expect(byName(cmds, "review")).toBeDefined();
        expect(byName(cmds, "personal")).toBeDefined();
    });

    it("namespaces subdirectories with a colon", async () => {
        const cmds = await loadMarkdownCommands({ projectRoot: root, userDir });
        expect(byName(cmds, "git:sync")).toBeDefined();
    });

    it("skips non-markdown files and untypeable names", async () => {
        const cmds = await loadMarkdownCommands({ projectRoot: root, userDir });
        expect(byName(cmds, "notes")).toBeUndefined();
        expect(byName(cmds, "9bad")).toBeUndefined();
    });

    it("uses frontmatter for description and usage", async () => {
        const cmds = await loadMarkdownCommands({ projectRoot: root, userDir });
        const ship = byName(cmds, "ship");
        expect(ship?.description).toBe("Ship it");
        expect(ship?.usage).toBe("/ship <version>");
    });

    it("falls back to a generated description without frontmatter", async () => {
        const cmds = await loadMarkdownCommands({ projectRoot: root, userDir });
        expect(byName(cmds, "review")?.description).toContain("project");
        expect(byName(cmds, "personal")?.description).toContain("user");
    });

    it("lets a project command shadow a user command of the same name", async () => {
        const cmds = await loadMarkdownCommands({ projectRoot: root, userDir });
        expect(cmds.filter((c) => c.name === "shared")).toHaveLength(1);
        sent.length = 0;
        byName(cmds, "shared")?.execute("", ctx);
        expect(sent).toEqual(["project body"]);
    });

    it("substitutes $ARGUMENTS raw", async () => {
        const cmds = await loadMarkdownCommands({ projectRoot: root, userDir });
        sent.length = 0;
        byName(cmds, "review")?.execute("  src/a.ts and src/b.ts  ", ctx);
        expect(sent).toEqual(["Review the diff in src/a.ts and src/b.ts carefully."]);
    });

    it("shell-quotes positional arguments", async () => {
        const cmds = await loadMarkdownCommands({ projectRoot: root, userDir });
        sent.length = 0;
        byName(cmds, "git:sync")?.execute("feature main", ctx);
        expect(sent).toEqual(["Sync branch 'feature' onto 'main'."]);
    });

    it("leaves missing positionals empty", async () => {
        const cmds = await loadMarkdownCommands({ projectRoot: root, userDir });
        sent.length = 0;
        byName(cmds, "git:sync")?.execute("feature", ctx);
        expect(sent).toEqual(["Sync branch 'feature' onto ."]);
    });

    it("returns nothing when neither directory exists", async () => {
        const cmds = await loadMarkdownCommands({
            projectRoot: join(root, "missing"),
            userDir: join(root, "also-missing"),
        });
        expect(cmds).toEqual([]);
    });
});
