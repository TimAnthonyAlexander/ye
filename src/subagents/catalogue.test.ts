import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import {
    buildAgentCatalogue,
    CUSTOM_AGENT_TOOL_CEILING,
    resetAgentCatalogue,
    resolveAgent,
    resolveKind,
    unknownKindError,
} from "./index.ts";
import { loadCustomAgents } from "./custom/load.ts";
import { GENERAL_TOOLS } from "./kinds/general.ts";
import { VERIFICATION_TOOLS } from "./kinds/verification.ts";

const agentFile = (frontmatter: string, body: string): string =>
    `---\n${frontmatter}\n---\n\n${body}\n`;

const REVIEWER = agentFile(
    [
        "name: reviewer",
        "description: Reviews a diff.",
        "tools: Read, Task, Write, Diagnostics, WebFetch",
    ].join("\n"),
    "Review the diff and report every problem you find.",
);

let root: string;

const writeAgent = async (dir: string, name: string, contents: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.md`), contents, "utf8");
};

const projectAgentsDir = (): string => join(root, ".ye", "agents");

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ye-agents-"));
    resetAgentCatalogue();
});

describe("custom agents", () => {
    test("a markdown agent loads from the project directory", async () => {
        await writeAgent(projectAgentsDir(), "reviewer", REVIEWER);
        const entry = buildAgentCatalogue(root).byName.get("reviewer");
        expect(entry?.source).toBe("project");
        expect(entry?.description).toBe("Reviews a diff.");
    });

    test("declared tools intersect the ceiling instead of widening it", async () => {
        await writeAgent(projectAgentsDir(), "reviewer", REVIEWER);
        const entry = buildAgentCatalogue(root).byName.get("reviewer");
        expect(entry?.tools).toEqual(["Read", "Write", "Diagnostics"]);
        expect(entry?.tools).not.toContain("Task");
        expect(entry?.tools).not.toContain("WebFetch");
    });

    test("Task is never on the ceiling", () => {
        expect(CUSTOM_AGENT_TOOL_CEILING).not.toContain("Task");
    });

    test("an agent that declares no tools gets the ceiling", async () => {
        await writeAgent(
            projectAgentsDir(),
            "quiet",
            agentFile("name: quiet\ndescription: No tool list.", "Think about it."),
        );
        expect(buildAgentCatalogue(root).byName.get("quiet")?.tools).toEqual(
            CUSTOM_AGENT_TOOL_CEILING,
        );
    });

    test("maxTurns stays clamped by the config ceiling", async () => {
        await writeAgent(
            projectAgentsDir(),
            "greedy",
            agentFile("name: greedy\ndescription: Wants more.\nmaxTurns: 999", "Do the thing."),
        );
        expect(buildAgentCatalogue(root).byName.get("greedy")?.maxTurns).toBe(999);
        expect(resolveAgent({ kind: "greedy", prompt: "go" }, root, 25).maxTurns).toBe(25);
    });

    test("the body becomes the system prompt", async () => {
        await writeAgent(projectAgentsDir(), "reviewer", REVIEWER);
        const resolved = resolveAgent({ kind: "reviewer", prompt: "go" }, root, 25);
        expect(resolved.systemPrompt).toContain("Review the diff and report every problem");
        expect(resolved.systemPrompt).toContain(root);
    });

    test("the .ye project dir beats the .claude project dir on a name conflict", async () => {
        await writeAgent(
            join(root, ".claude", "agents"),
            "reviewer",
            agentFile("name: reviewer\ndescription: The claude copy.", "Claude body."),
        );
        await writeAgent(projectAgentsDir(), "reviewer", REVIEWER);

        const loaded = loadCustomAgents(root);
        expect(loaded).toHaveLength(1);
        expect(loaded[0]?.source).toBe("project");
        expect(loaded[0]?.description).toBe("Reviews a diff.");
    });

    test("a .claude agent loads and its name need not match the filename", async () => {
        await writeAgent(
            join(root, ".claude", "agents"),
            "any-filename",
            agentFile("name: cc-reviewer\ndescription: Claude Code agent.", "Review it."),
        );
        const entry = buildAgentCatalogue(root).byName.get("cc-reviewer");
        expect(entry?.source).toBe("claude-project");
        expect(entry?.description).toBe("Claude Code agent.");
    });

    test("a built-in kind beats a markdown file of the same name", async () => {
        await writeAgent(
            projectAgentsDir(),
            "general",
            agentFile("name: general\ndescription: Hijacked.\ntools: Read", "Do nothing."),
        );
        const entry = buildAgentCatalogue(root).byName.get("general");
        expect(entry?.source).toBe("builtin");
        expect(entry?.tools).toEqual(GENERAL_TOOLS);
    });

    describe("malformed files", () => {
        const cases: ReadonlyArray<readonly [string, string, string]> = [
            ["no frontmatter", "nofm", "just a body, no delimiters\n"],
            ["unclosed frontmatter", "unclosed", "---\nname: unclosed\ndescription: x\n"],
            ["missing description", "nodesc", agentFile("name: nodesc", "body")],
            [
                "name that does not match the filename",
                "mismatch",
                agentFile("name: other\ndescription: x", "body"),
            ],
            [
                "illegal name charset",
                "Bad_Name",
                agentFile("name: Bad_Name\ndescription: x", "body"),
            ],
            ["empty body", "empty", agentFile("name: empty\ndescription: x", "")],
        ];

        for (const [label, fileName, contents] of cases) {
            test(`${label} is skipped and the good sibling still loads`, async () => {
                await writeAgent(projectAgentsDir(), fileName, contents);
                await writeAgent(projectAgentsDir(), "reviewer", REVIEWER);
                const catalogue = buildAgentCatalogue(root);
                expect(catalogue.byName.has(fileName)).toBe(false);
                expect(catalogue.byName.has("reviewer")).toBe(true);
            });
        }

        test("loading writes nothing to stdout", async () => {
            await writeAgent(projectAgentsDir(), "nofm", "not an agent file\n");
            const original = process.stdout.write.bind(process.stdout);
            const written: string[] = [];
            process.stdout.write = ((chunk: string | Uint8Array): boolean => {
                written.push(String(chunk));
                return true;
            }) as typeof process.stdout.write;
            try {
                buildAgentCatalogue(root);
            } finally {
                process.stdout.write = original;
            }
            expect(written).toEqual([]);
        });
    });

    // Claude Code's kinds are `general-purpose` and `Explore`; ours are
    // `general` and `explore`. Same agents, so name them rather than fail.
    test("Claude Code's agent names resolve to ours", () => {
        expect(resolveKind("general-purpose", root)).toBe("general");
        expect(resolveKind("Explore", root)).toBe("explore");
        expect(resolveKind("explore", root)).toBe("explore");
        expect(resolveKind("nope", root)).toBe("nope");
    });

    test("an unknown kind reports the valid ones", () => {
        const message = unknownKindError("nope", root);
        expect(message).toContain("unknown subagent kind: nope");
        for (const name of ["explore", "general", "verification", "fork"]) {
            expect(message).toContain(name);
        }
        expect(() => resolveAgent({ kind: "nope", prompt: "go" }, root, 25)).toThrow(
            "unknown subagent kind",
        );
    });
});

describe("verification", () => {
    test("uses the Diagnostics tool instead of shelling out to typecheck", () => {
        expect(VERIFICATION_TOOLS).toContain("Diagnostics");
        expect(buildAgentCatalogue(root).byName.get("verification")?.tools).toContain(
            "Diagnostics",
        );
        expect(
            resolveAgent({ kind: "verification", prompt: "check" }, root, 25).systemPrompt,
        ).toContain("Diagnostics");
    });
});
