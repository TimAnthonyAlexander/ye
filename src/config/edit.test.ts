import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteAt, getAt, hasAt, setAt } from "./dotted.ts";
import { applyConfigEdits, applyEdits, editFor, ensureInvariants } from "./edit.ts";
import { fieldByPath, type FieldRow, type RowOrigin } from "./registry.ts";
import { validateConfig } from "./validate.ts";

let workDir: string;
let configPath: string;

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ye-config-edit-"));
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

const row = (path: string, origin: RowOrigin): FieldRow => {
    const field = fieldByPath(path);
    if (!field) throw new Error(`no field ${path}`);
    return { kind: "field", field, value: field.defaultValue, origin };
};

describe("dotted paths", () => {
    const tree = { a: { b: { c: 1 }, d: 2 }, e: 3 };

    test("get walks the path", () => {
        expect(getAt(tree, ["a", "b", "c"])).toBe(1);
        expect(getAt(tree, ["a", "missing"])).toBeUndefined();
        expect(getAt(tree, ["e", "deeper"])).toBeUndefined();
    });

    test("has distinguishes an explicit key from a missing one", () => {
        expect(hasAt({ a: { b: undefined } }, ["a", "b"])).toBe(true);
        expect(hasAt(tree, ["a", "z"])).toBe(false);
    });

    test("set creates missing parents without mutating the input", () => {
        const next = setAt(tree, ["x", "y"], 9);
        expect(getAt(next, ["x", "y"])).toBe(9);
        expect(getAt(next, ["a", "b", "c"])).toBe(1);
        expect(getAt(tree, ["x", "y"])).toBeUndefined();
    });

    test("set replaces a non-object on the way down", () => {
        expect(getAt(setAt(tree, ["e", "f"], 1), ["e", "f"])).toBe(1);
    });

    test("delete removes the leaf and prunes the block it emptied", () => {
        const next = deleteAt(tree, ["a", "b", "c"]);
        expect(getAt(next, ["a", "b"])).toBeUndefined();
        expect(getAt(next, ["a", "d"])).toBe(2);
    });

    test("delete of a missing path is a no-op", () => {
        expect(deleteAt(tree, ["nope", "here"])).toBe(tree);
    });
});

describe("editFor", () => {
    test("a value equal to the default is not written when the key is absent", () => {
        expect(editFor(row("gitStatus.enabled", "default"), true)).toEqual({
            path: "gitStatus.enabled",
            value: undefined,
        });
    });

    test("a key already in the file keeps being written at its default", () => {
        expect(editFor(row("gitStatus.enabled", "configured"), true)).toEqual({
            path: "gitStatus.enabled",
            value: true,
        });
    });

    test("a non-default value is always written", () => {
        expect(editFor(row("gitStatus.enabled", "default"), false)).toEqual({
            path: "gitStatus.enabled",
            value: false,
        });
    });

    test("unset always removes", () => {
        expect(editFor(row("verify.test", "configured"), undefined)).toEqual({
            path: "verify.test",
            value: undefined,
        });
    });
});

describe("ensureInvariants", () => {
    test("a partial block gets the keys the validator demands", () => {
        const out = ensureInvariants({ maxTurns: { master: 40 } });
        expect(out["maxTurns"]).toEqual({ master: 40, subagent: 25 });
    });

    test("permissions gets a defaultMode and a rules array", () => {
        const out = ensureInvariants({ permissions: { heuristicGating: false } });
        expect(out["permissions"]).toEqual({
            heuristicGating: false,
            defaultMode: "NORMAL",
            rules: [],
        });
    });

    test("compact gets its threshold", () => {
        expect(ensureInvariants({ compact: { snipFloor: 0.4 } })["compact"]).toEqual({
            snipFloor: 0.4,
            threshold: 0.5,
        });
    });

    test("an absent block is left absent", () => {
        expect(ensureInvariants({ autoDetect: false })).toEqual({ autoDetect: false });
    });

    test("existing values are never overwritten", () => {
        const out = ensureInvariants({ maxTurns: { master: 40, subagent: 3 } });
        expect(out["maxTurns"]).toEqual({ master: 40, subagent: 3 });
    });
});

describe("applyEdits", () => {
    test("sets and deletes in one pass without mutating the input", () => {
        const root = { verify: { test: "bun test", lint: "eslint ." } };
        const next = applyEdits(root, [
            { path: "verify.test", value: undefined },
            { path: "budget.maxUsd", value: 5 },
        ]);
        expect(next).toEqual({ verify: { lint: "eslint ." }, budget: { maxUsd: 5 } });
        expect(root.verify.test).toBe("bun test");
    });
});

describe("applyConfigEdits", () => {
    const EXISTING = {
        defaultProvider: "openrouter",
        providers: { openrouter: { baseUrl: "https://x", apiKeyEnv: "K", apiKey: "sk-secret" } },
        defaultModel: { provider: "openrouter", model: "m", routing: "cheapest" },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
        somethingTheValidatorDropsOnTheFloor: { keep: "me" },
    };

    test("keys the validator does not model survive the write", async () => {
        await seed(EXISTING);
        await applyConfigEdits([{ path: "suggestions.enabled", value: true }], configPath);

        const out = await readJson();
        expect(out["somethingTheValidatorDropsOnTheFloor"]).toEqual({ keep: "me" });
        expect(out["providers"]).toEqual(EXISTING.providers);
        expect(out["hooks"]).toEqual(EXISTING.hooks);
        expect(out["suggestions"]).toEqual({ enabled: true });
    });

    test("the result still loads through the validator", async () => {
        await seed(EXISTING);
        await applyConfigEdits(
            [
                { path: "permissions.defaultMode", value: "AUTO" },
                { path: "maxTurns.master", value: 40 },
                { path: "compact.snipFloor", value: 0.4 },
            ],
            configPath,
        );
        const config = validateConfig(await readJson());
        expect(config.permissions?.defaultMode).toBe("AUTO");
        expect(config.permissions?.rules).toEqual([]);
        expect(config.maxTurns).toEqual({ master: 40, subagent: 25 });
        expect(config.compact?.threshold).toBe(0.5);
        expect(config.compact?.snipFloor).toBe(0.4);
    });

    test("a delete removes the key and prunes the emptied block", async () => {
        await seed({ ...EXISTING, budget: { maxUsd: 5 } });
        await applyConfigEdits([{ path: "budget.maxUsd", value: undefined }], configPath);
        const out = await readJson();
        expect(out["budget"]).toBeUndefined();
        expect(out["defaultProvider"]).toBe("openrouter");
    });

    test("a delete inside a shared block keeps its siblings", async () => {
        await seed({ ...EXISTING, verify: { test: "bun test", lint: "eslint ." } });
        await applyConfigEdits([{ path: "verify.test", value: undefined }], configPath);
        expect((await readJson())["verify"]).toEqual({ lint: "eslint ." });
    });

    test("an absent file is created rather than failing", async () => {
        await applyConfigEdits([{ path: "autoDetect", value: false }], configPath);
        expect(await readJson()).toEqual({ autoDetect: false });
    });

    test("leaves no temp file behind", async () => {
        await seed(EXISTING);
        await applyConfigEdits([{ path: "autoDetect", value: false }], configPath);
        expect(await readdir(workDir)).toEqual(["config.json"]);
    });

    test("a failed write leaves the previous file intact", async () => {
        const dirPath = join(workDir, "as-a-dir");
        await Bun.write(join(dirPath, "inner.txt"), "x");
        await expect(
            applyConfigEdits([{ path: "autoDetect", value: false }], dirPath),
        ).rejects.toThrow();
        expect(await Bun.file(join(dirPath, "inner.txt")).text()).toBe("x");
        expect((await readdir(workDir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });
});
