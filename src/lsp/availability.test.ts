import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDetectionCache, resolveLsp } from "../config/detect.ts";
import type { Config } from "../config/types.ts";
import { LSP_BIN_DIR } from "../storage/paths.ts";
import { listTools } from "../tools/registry.ts";
import { invalidateLspAvailability, lspToolsAvailable } from "./availability.ts";

const BASE: Config = {
    defaultProvider: "stub",
    providers: { stub: { baseUrl: "https://example.test", apiKeyEnv: "STUB_KEY" } },
    defaultModel: { provider: "stub", model: "stub-model" },
};

const TS_SERVER = join(LSP_BIN_DIR, "typescript-language-server");

let root: string;
let originalPath: string | undefined;
const installed: string[] = [];

const install = async (name: string): Promise<void> => {
    const path = join(LSP_BIN_DIR, name);
    // Never clobber a real install: this is the user's own ~/.ye/lsp/bin.
    if (existsSync(path)) return;
    await mkdir(LSP_BIN_DIR, { recursive: true });
    await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(path, 0o755);
    installed.push(path);
};

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ye-availability-test-"));
    originalPath = process.env.PATH;
    const empty = join(root, "empty-bin");
    await mkdir(empty, { recursive: true });
    process.env.PATH = empty;
    _resetDetectionCache();
});

afterEach(async () => {
    process.env.PATH = originalPath;
    for (const path of installed) await rm(path, { force: true });
    installed.length = 0;
    _resetDetectionCache();
    // Later suites read the real answer, not the one this file staged.
    invalidateLspAvailability();
    await rm(root, { recursive: true, force: true });
});

describe("lsp availability invalidation", () => {
    test("A1 invalidating drops the detection cached for the given root", async () => {
        await writeFile(join(root, "go.mod"), "module fixture\n", "utf8");
        expect(resolveLsp(BASE, root).value.enabled).toBe(false);

        await install("gopls");
        expect(resolveLsp(BASE, root).value.enabled).toBe(false);

        invalidateLspAvailability(root);
        expect(resolveLsp(BASE, root).value.servers).toEqual({ go: { command: "gopls" } });
    });

    test("A2 a freshly installed server puts the navigation tools back in the pool", async () => {
        invalidateLspAvailability();
        // A machine that already resolves a server cannot show the transition,
        // and nothing here may overwrite a real install to force it.
        if (existsSync(TS_SERVER) || lspToolsAvailable()) return;
        expect(listTools().map((t) => t.name)).not.toContain("Definition");

        await install("typescript-language-server");
        expect(lspToolsAvailable()).toBe(false);

        invalidateLspAvailability();
        expect(lspToolsAvailable()).toBe(true);
        expect(listTools().map((t) => t.name)).toContain("Definition");
    });
});
