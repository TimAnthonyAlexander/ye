import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBuiltinSkills } from "./builtin.ts";
import { buildSkillToolDescription } from "./description.ts";
import { resolveSkillModel } from "./model.ts";
import { parseSkillFile } from "./parse.ts";
import { loadSkillRegistry } from "./registry.ts";
import { skillToSlashCommand } from "./slashAdapter.ts";
import type { Skill, SkillManifest, SkillRegistry } from "./types.ts";
import { SkillError } from "./types.ts";

const parse = (frontmatter: string): Skill | SkillError =>
    parseSkillFile({
        text: `---\nname: demo\ndescription: A demo skill.\n${frontmatter}\n---\n\nBody text.\n`,
        source: { tier: "user", path: "/skills/demo/SKILL.md", directory: "/skills/demo" },
        directoryName: null,
    });

const manifestOf = (frontmatter: string): SkillManifest => {
    const result = parse(frontmatter);
    if (result instanceof SkillError) throw new Error(`unexpected SkillError: ${result.message}`);
    return result.manifest;
};

const mkSkill = (manifest: SkillManifest): Skill => ({
    manifest,
    body: "Body.",
    source: { tier: "user", path: `/skills/${manifest.name}/SKILL.md`, directory: null },
});

const mkRegistry = (skills: readonly Skill[]): SkillRegistry => ({
    all: new Map(skills.map((s) => [s.manifest.name, s])),
    modelInvocable: skills,
    slashBound: skills,
});

describe("frontmatter: allowed-tools / disallowed-tools", () => {
    test("whitespace-separated list (the form the builtin skills use)", () => {
        expect(manifestOf("allowed-tools: Read Glob Bash").allowedTools).toEqual([
            "Read",
            "Glob",
            "Bash",
        ]);
    });

    test("comma-separated list", () => {
        expect(manifestOf("allowed-tools: Read, Grep,Glob").allowedTools).toEqual([
            "Read",
            "Grep",
            "Glob",
        ]);
    });

    test("inline YAML array", () => {
        expect(manifestOf('allowed-tools: ["Read", "Grep"]').allowedTools).toEqual([
            "Read",
            "Grep",
        ]);
    });

    test("YAML block sequence", () => {
        expect(manifestOf("allowed-tools:\n  - Read\n  - Grep").allowedTools).toEqual([
            "Read",
            "Grep",
        ]);
    });

    test("disallowed-tools parses independently of allowed-tools", () => {
        const manifest = manifestOf("disallowed-tools: Bash, Write");
        expect(manifest.disallowedTools).toEqual(["Bash", "Write"]);
        expect(manifest.allowedTools).toBeUndefined();
    });

    test("a malformed value drops the key without killing the skill", () => {
        const manifest = manifestOf("allowed-tools: 42");
        expect(manifest.allowedTools).toBeUndefined();
        expect(manifest.name).toBe("demo");
        expect(manifest.description).toBe("A demo skill.");
    });

    test("garbage entries are dropped, valid ones kept (narrower, never wider)", () => {
        expect(manifestOf("allowed-tools: Read, 42, Grep").allowedTools).toEqual(["Read", "Grep"]);
    });

    test("an empty list value is treated as absent", () => {
        expect(manifestOf("allowed-tools:").allowedTools).toBeUndefined();
    });
});

describe("frontmatter: model", () => {
    test("a plain model id is kept", () => {
        expect(manifestOf("model: anthropic/claude-opus-4.8").model).toBe(
            "anthropic/claude-opus-4.8",
        );
    });

    test("a value with whitespace is skipped", () => {
        expect(manifestOf("model: not a model id").model).toBeUndefined();
    });

    test("an empty value is skipped", () => {
        expect(manifestOf("model:").model).toBeUndefined();
    });
});

describe("frontmatter: argument-hint", () => {
    test("is kept verbatim", () => {
        expect(manifestOf("argument-hint: <pr-number> [--draft]").argumentHint).toBe(
            "<pr-number> [--draft]",
        );
    });

    test("surfaces in the slash-command usage string", () => {
        const cmd = skillToSlashCommand(
            mkSkill({ name: "demo", description: "d", argumentHint: "<file>" }),
        );
        expect(cmd.usage).toBe("/demo <file>");
    });

    test("usage falls back to the bare command when absent", () => {
        const cmd = skillToSlashCommand(mkSkill({ name: "demo", description: "d" }));
        expect(cmd.usage).toBe("/demo");
    });

    test("surfaces in the Skill tool catalogue", () => {
        const withHint = buildSkillToolDescription(
            mkRegistry([mkSkill({ name: "demo", description: "d", argumentHint: "<file>" })]),
        );
        expect(withHint).toContain("- demo: d (args: <file>)");

        const withoutHint = buildSkillToolDescription(
            mkRegistry([mkSkill({ name: "demo", description: "d" })]),
        );
        expect(withoutHint).toContain("- demo: d [<embedded>]");
    });
});

describe("frontmatter: invocation flags", () => {
    test("user-invocable parses as a boolean", () => {
        expect(manifestOf("user-invocable: false").userInvocable).toBe(false);
        expect(manifestOf("user-invocable: true").userInvocable).toBe(true);
        expect(manifestOf("user-invocable: maybe").userInvocable).toBeUndefined();
        expect(manifestOf("model: x").userInvocable).toBeUndefined();
    });

    test("user-invocable and disable-model-invocation compose without crashing", () => {
        const manifest = manifestOf("user-invocable: false\ndisable-model-invocation: true");
        expect(manifest.userInvocable).toBe(false);
        expect(manifest.disableModelInvocation).toBe(true);
    });
});

describe("frontmatter: unknown keys", () => {
    test("are still ignored silently", () => {
        const manifest = manifestOf("version: 2\nlicense: MIT\nmetadata: whatever");
        expect(manifest.name).toBe("demo");
        expect(manifest.allowedTools).toBeUndefined();
    });
});

describe("builtin skills", () => {
    test("still load, with their declared tool lists honoured", () => {
        const builtins = loadBuiltinSkills();
        expect(builtins.map((s) => s.manifest.name).sort()).toEqual([
            "frontend-design",
            "project-init",
        ]);
        const projectInit = builtins.find((s) => s.manifest.name === "project-init");
        expect(projectInit?.manifest.allowedTools).toEqual([
            "Read",
            "Glob",
            "Bash",
            "Write",
            "Edit",
        ]);
    });
});

describe("registry: user-invocable: false", () => {
    const writeSkill = (root: string, name: string, frontmatter: string): void => {
        const dir = join(root, ".ye", "skills", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "SKILL.md"),
            `---\nname: ${name}\ndescription: ${name} skill.\n${frontmatter}\n---\n\nBody.\n`,
        );
    };

    test("hides from the slash surface but keeps the skill model-invocable", async () => {
        const root = mkdtempSync(join(tmpdir(), "ye-skills-"));
        writeSkill(root, "zz-hidden-skill", "user-invocable: false");
        writeSkill(root, "zz-visible-skill", "argument-hint: <x>");
        writeSkill(
            root,
            "zz-degenerate-skill",
            "user-invocable: false\ndisable-model-invocation: true",
        );

        const registry = await loadSkillRegistry({ projectRoot: root });
        const slash = registry.slashBound.map((s) => s.manifest.name);
        const model = registry.modelInvocable.map((s) => s.manifest.name);

        expect(registry.all.has("zz-hidden-skill")).toBe(true);
        expect(slash).not.toContain("zz-hidden-skill");
        expect(model).toContain("zz-hidden-skill");

        expect(slash).toContain("zz-visible-skill");
        expect(model).toContain("zz-visible-skill");

        // Invisible on both surfaces, still resolvable by name.
        expect(slash).not.toContain("zz-degenerate-skill");
        expect(model).not.toContain("zz-degenerate-skill");
        expect(registry.all.has("zz-degenerate-skill")).toBe(true);
    });

    test("a .claude/skills project skill loads under its directory name", async () => {
        const root = mkdtempSync(join(tmpdir(), "ye-skills-"));
        const dir = join(root, ".claude", "skills", "zz-deploy");
        mkdirSync(dir, { recursive: true });
        // Frontmatter name deliberately differs from the directory — Claude Code
        // identifies the skill by directory, and so must we.
        writeFileSync(
            join(dir, "SKILL.md"),
            "---\nname: Deploy Helper\ndescription: A deploy skill.\n---\n\nBody.\n",
        );

        const registry = await loadSkillRegistry({ projectRoot: root });
        const skill = registry.all.get("zz-deploy");
        expect(skill).toBeDefined();
        expect(skill?.source.tier).toBe("claude-project");
    });

    test("the .ye project tier overrides a .claude skill of the same name", async () => {
        const root = mkdtempSync(join(tmpdir(), "ye-skills-"));
        const claudeDir = join(root, ".claude", "skills", "zz-shared");
        mkdirSync(claudeDir, { recursive: true });
        writeFileSync(
            join(claudeDir, "SKILL.md"),
            "---\nname: zz-shared\ndescription: Claude copy.\n---\n\nClaude body.\n",
        );
        writeSkill(root, "zz-shared", "");

        const registry = await loadSkillRegistry({ projectRoot: root });
        const skill = registry.all.get("zz-shared");
        expect(skill?.source.tier).toBe("project");
        expect(skill?.manifest.description).toBe("zz-shared skill.");
    });
});

describe("resolveSkillModel", () => {
    const resolve = (requested: string, providerId: string) =>
        resolveSkillModel({
            skillName: "demo",
            requested,
            providerId,
            activeModel: "active-model",
        });

    test("resolves a registered model on its own provider", () => {
        const r = resolve("claude-opus-4-8", "anthropic");
        expect(r.model).toBe("claude-opus-4-8");
        expect(r.notice).toBeNull();
    });

    test("falls back with a one-line notice when the model belongs to another provider", () => {
        const r = resolve("claude-opus-4-8", "openai");
        expect(r.model).toBeNull();
        expect(r.notice).toContain("claude-opus-4-8");
        expect(r.notice).toContain("openai");
        expect(r.notice).toContain("active-model");
        expect(r.notice?.split("\n")).toHaveLength(1);
    });

    test("falls back for an unknown model on a closed-catalogue provider", () => {
        expect(resolve("no-such-model", "openai").model).toBeNull();
    });

    test("accepts unregistered ids on providers with a runtime catalogue", () => {
        expect(resolve("some-vendor/some-model:free", "openrouter").model).toBe(
            "some-vendor/some-model:free",
        );
        expect(resolve("qwen3:8b", "ollama").model).toBe("qwen3:8b");
    });

    test("a request for the already-active model is always resolvable", () => {
        const r = resolve("active-model", "openai");
        expect(r.model).toBe("active-model");
        expect(r.notice).toBeNull();
    });
});
