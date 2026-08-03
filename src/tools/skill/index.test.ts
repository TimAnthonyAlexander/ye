import { describe, expect, test } from "bun:test";
import type { Config } from "../../config/index.ts";
import type { Provider } from "../../providers/index.ts";
import { clearSkillScope, getSkillScope } from "../../skills/scope.ts";
import type { Skill, SkillManifest, SkillRegistry } from "../../skills/types.ts";
import type { ToolContext } from "../types.ts";
import { setSkillRegistry, SkillTool } from "./index.ts";

const stubConfig: Config = {
    defaultProvider: "stub",
    providers: { stub: { baseUrl: "https://example.test", apiKeyEnv: "STUB_KEY" } },
    defaultModel: { provider: "stub", model: "stub-model" },
};

const stubProvider = (id: string): Provider => ({
    id,
    capabilities: { promptCache: false, toolUse: true, vision: false, serverSideWebSearch: false },
    async *stream() {
        // no-op
    },
    async getContextSize() {
        return 100_000;
    },
});

const mkSkill = (manifest: SkillManifest): Skill => ({
    manifest,
    body: "Do the thing.",
    source: { tier: "user", path: `/skills/${manifest.name}/SKILL.md`, directory: null },
});

const SKILLS: readonly Skill[] = [
    mkSkill({
        name: "narrow",
        description: "narrows tools",
        allowedTools: ["Read", "Grep"],
        disallowedTools: ["Bash"],
    }),
    mkSkill({ name: "plain", description: "declares nothing" }),
    mkSkill({ name: "pinned", description: "pins a model", model: "claude-opus-4-8" }),
];

setSkillRegistry(
    {
        all: new Map(SKILLS.map((s) => [s.manifest.name, s])),
        modelInvocable: SKILLS,
        slashBound: SKILLS,
    } satisfies SkillRegistry,
    "stub description",
);

const uniqueSession = (() => {
    let n = 0;
    return () => `skill-scope-session-${++n}`;
})();

const makeCtx = (sessionId: string, providerId: string): ToolContext => ({
    cwd: "/tmp/test",
    signal: new AbortController().signal,
    sessionId,
    projectId: "skill-test-project",
    turnIndex: 0,
    turnState: { readFiles: new Map(), todos: [] },
    provider: stubProvider(providerId),
    config: stubConfig,
    activeModel: "stub-model",
    headless: false,
    log: () => {},
});

const run = async (sessionId: string, providerId: string, command: string): Promise<string> => {
    const result = await SkillTool.execute({ command }, makeCtx(sessionId, providerId));
    if (!result.ok) throw new Error(result.error);
    return result.value.body;
};

describe("Skill tool scope", () => {
    test("a skill's tool declarations become the session's skill scope", async () => {
        const sessionId = uniqueSession();
        await run(sessionId, "anthropic", "narrow");
        expect(getSkillScope(sessionId)).toEqual({
            skillName: "narrow",
            allowedTools: ["Read", "Grep"],
            disallowedTools: ["Bash"],
        });
        clearSkillScope(sessionId);
    });

    test("a skill that declares nothing clears the previous scope", async () => {
        const sessionId = uniqueSession();
        await run(sessionId, "anthropic", "narrow");
        expect(getSkillScope(sessionId)).toBeDefined();
        await run(sessionId, "anthropic", "plain");
        expect(getSkillScope(sessionId)).toBeUndefined();
    });

    test("scopes are per session", async () => {
        const a = uniqueSession();
        const b = uniqueSession();
        await run(a, "anthropic", "narrow");
        expect(getSkillScope(b)).toBeUndefined();
        clearSkillScope(a);
    });

    test("a resolvable model is pinned on the scope, silently", async () => {
        const sessionId = uniqueSession();
        const body = await run(sessionId, "anthropic", "pinned");
        expect(getSkillScope(sessionId)?.model).toBe("claude-opus-4-8");
        expect(body).not.toContain("Note:");
        clearSkillScope(sessionId);
    });

    test("an unresolvable model falls back and prefixes a one-line notice", async () => {
        const sessionId = uniqueSession();
        const body = await run(sessionId, "openai", "pinned");
        expect(getSkillScope(sessionId)).toBeUndefined();
        expect(body.split("\n")[0]).toContain('skill "pinned" requests model "claude-opus-4-8"');
        expect(body).toContain("Do the thing.");
        clearSkillScope(sessionId);
    });

    test("an unknown skill leaves any existing scope alone", async () => {
        const sessionId = uniqueSession();
        await run(sessionId, "anthropic", "narrow");
        const result = await SkillTool.execute(
            { command: "nope" },
            makeCtx(sessionId, "anthropic"),
        );
        expect(result.ok).toBe(false);
        expect(getSkillScope(sessionId)?.skillName).toBe("narrow");
        clearSkillScope(sessionId);
    });
});
