import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistPermissionRule, withPermissionRule } from "./loader.ts";
import type { Config, PermissionRule } from "./types.ts";

let workDir: string;
let configPath: string;

const RULE: PermissionRule = { effect: "allow", tool: "Bash", pattern: "Bash(npm *)" };

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-config-"));
    configPath = join(workDir, "config.json");
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

const seed = async (raw: unknown): Promise<void> => {
    await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
};

const readJson = async (): Promise<Record<string, unknown>> =>
    (await Bun.file(configPath).json()) as Record<string, unknown>;

describe("persistPermissionRule", () => {
    test("appends the rule and keeps unrelated keys untouched", async () => {
        await seed({
            defaultProvider: "openrouter",
            providers: { openrouter: { apiKey: "sk-secret" } },
            unknownFutureKey: { keep: true },
            permissions: { defaultMode: "NORMAL", rules: [{ effect: "deny", tool: "Write" }] },
        });

        expect(await persistPermissionRule(RULE, configPath)).toBe(true);

        const out = await readJson();
        expect(out["defaultProvider"]).toBe("openrouter");
        expect(out["providers"]).toEqual({ openrouter: { apiKey: "sk-secret" } });
        expect(out["unknownFutureKey"]).toEqual({ keep: true });
        const permissions = out["permissions"] as Record<string, unknown>;
        expect(permissions["defaultMode"]).toBe("NORMAL");
        expect(permissions["rules"]).toEqual([{ effect: "deny", tool: "Write" }, RULE]);
    });

    test("is idempotent for an identical rule", async () => {
        await seed({ permissions: { defaultMode: "AUTO", rules: [] } });
        expect(await persistPermissionRule(RULE, configPath)).toBe(true);
        expect(await persistPermissionRule(RULE, configPath)).toBe(false);
        const permissions = (await readJson())["permissions"] as Record<string, unknown>;
        expect(permissions["rules"]).toEqual([RULE]);
        expect(permissions["defaultMode"]).toBe("AUTO");
    });

    test("supplies a defaultMode when the file has no permissions block", async () => {
        await seed({ defaultProvider: "openrouter" });
        await persistPermissionRule(RULE, configPath);
        const permissions = (await readJson())["permissions"] as Record<string, unknown>;
        expect(permissions["defaultMode"]).toBe("NORMAL");
        expect(permissions["rules"]).toEqual([RULE]);
    });

    test("writes with mode 0600", async () => {
        await seed({ permissions: { defaultMode: "NORMAL", rules: [] } });
        await persistPermissionRule(RULE, configPath);
        const s = await stat(configPath);
        expect(s.mode & 0o777).toBe(0o600);
    });

    test("leaves no temp file behind", async () => {
        await seed({ permissions: { defaultMode: "NORMAL", rules: [] } });
        await persistPermissionRule(RULE, configPath);
        const entries = await readdir(workDir);
        expect(entries).toEqual(["config.json"]);
    });

    test("a failed write leaves the previous file intact and cleans up", async () => {
        // A directory in the config's place makes the rename fail after the temp
        // file has already been written — the crash-mid-write case.
        const dirPath = join(workDir, "as-a-dir");
        await Bun.write(join(dirPath, "inner.txt"), "x");

        await expect(persistPermissionRule(RULE, dirPath)).rejects.toThrow();

        expect(await Bun.file(join(dirPath, "inner.txt")).text()).toBe("x");
        const leftovers = (await readdir(workDir)).filter((n) => n.endsWith(".tmp"));
        expect(leftovers).toEqual([]);
    });
});

describe("withPermissionRule", () => {
    const base = { permissions: { defaultMode: "NORMAL", rules: [] } } as unknown as Config;

    test("adds the rule without mutating the input", () => {
        const next = withPermissionRule(base, RULE);
        expect(next.permissions?.rules).toEqual([RULE]);
        expect(base.permissions?.rules).toEqual([]);
    });

    test("does not duplicate an existing rule", () => {
        const once = withPermissionRule(base, RULE);
        expect(withPermissionRule(once, RULE)).toBe(once);
    });
});
