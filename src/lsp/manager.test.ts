import { describe, expect, test } from "bun:test";
import type { Config, LspServerConfig } from "../config/types.ts";
import { declaresLspServers } from "./availability.ts";
import { languageForPath } from "./languages.ts";
import { isLspEnabled, resolveServerForFile } from "./manager.ts";

const server: LspServerConfig = { command: "fake-server", args: ["--stdio"] };

const configWith = (lsp?: Config["lsp"]): Config => ({
    defaultProvider: "stub",
    providers: { stub: { baseUrl: "https://example.test", apiKeyEnv: "STUB_KEY" } },
    defaultModel: { provider: "stub", model: "stub-model" },
    ...(lsp ? { lsp } : {}),
});

describe("language mapping", () => {
    test("L1 every TS/JS extension resolves to a server configured as `typescript`", () => {
        const config = configWith({ enabled: true, servers: { typescript: server } });
        for (const path of [
            "/p/a.ts",
            "/p/a.tsx",
            "/p/a.mts",
            "/p/a.cts",
            "/p/a.js",
            "/p/a.jsx",
            "/p/a.mjs",
            "/p/a.cjs",
        ]) {
            const lookup = resolveServerForFile(config, path);
            expect(lookup.ok).toBe(true);
            if (lookup.ok) expect(lookup.target.configKey).toBe("typescript");
        }
    });

    test("L2 didOpen language ids stay specific per extension", () => {
        expect(languageForPath("/p/a.ts")?.languageId).toBe("typescript");
        expect(languageForPath("/p/a.tsx")?.languageId).toBe("typescriptreact");
        expect(languageForPath("/p/a.js")?.languageId).toBe("javascript");
        expect(languageForPath("/p/a.jsx")?.languageId).toBe("javascriptreact");
        expect(languageForPath("/p/a.py")?.languageId).toBe("python");
        expect(languageForPath("/p/a.go")?.languageId).toBe("go");
        expect(languageForPath("/p/a.rs")?.languageId).toBe("rust");
        expect(languageForPath("/p/a.zzz")).toBeUndefined();
    });

    test("L3 an exact language key wins over the typescript fallback", () => {
        const javascript: LspServerConfig = { command: "js-server" };
        const config = configWith({ enabled: true, servers: { typescript: server, javascript } });
        const lookup = resolveServerForFile(config, "/p/a.js");

        expect(lookup.ok).toBe(true);
        if (lookup.ok) expect(lookup.target.server.command).toBe("js-server");
    });

    test("L4 python, go and rust resolve from their own keys", () => {
        const config = configWith({
            enabled: true,
            servers: { python: server, go: server, rust: server },
        });
        for (const [path, key] of [
            ["/p/a.py", "python"],
            ["/p/a.go", "go"],
            ["/p/a.rs", "rust"],
        ] as const) {
            const lookup = resolveServerForFile(config, path);
            expect(lookup.ok).toBe(true);
            if (lookup.ok) expect(lookup.target.configKey).toBe(key);
        }
    });
});

describe("server resolution", () => {
    test("L5 lsp missing or disabled reports `disabled`", () => {
        expect(resolveServerForFile(configWith(), "/p/a.ts")).toEqual({
            ok: false,
            reason: "disabled",
        });
        expect(
            resolveServerForFile(
                configWith({ enabled: false, servers: { typescript: server } }),
                "/p/a.ts",
            ),
        ).toEqual({ ok: false, reason: "disabled" });
        expect(resolveServerForFile(configWith({ enabled: true, servers: {} }), "/p/a.ts")).toEqual(
            {
                ok: false,
                reason: "disabled",
            },
        );
    });

    test("L6 an unmapped extension is reported apart from an unconfigured language", () => {
        const config = configWith({ enabled: true, servers: { typescript: server } });
        expect(resolveServerForFile(config, "/p/a.zzz")).toEqual({
            ok: false,
            reason: "unmapped",
            extension: ".zzz",
        });

        const lookup = resolveServerForFile(config, "/p/a.py");
        expect(lookup.ok).toBe(false);
        if (!lookup.ok && lookup.reason === "unconfigured") {
            expect(lookup.languageId).toBe("python");
            expect(lookup.configKeys[0]).toBe("python");
        }
    });

    test("L7 isLspEnabled requires both the flag and at least one server", () => {
        expect(isLspEnabled(configWith({ enabled: true, servers: { typescript: server } }))).toBe(
            true,
        );
        expect(isLspEnabled(configWith({ enabled: true }))).toBe(false);
        expect(isLspEnabled(configWith())).toBe(false);
    });

    test("L8 the registry's availability predicate matches the same rule", () => {
        expect(declaresLspServers({ lsp: { enabled: true, servers: { go: server } } })).toBe(true);
        expect(declaresLspServers({ lsp: { enabled: true, servers: {} } })).toBe(false);
        expect(declaresLspServers({ lsp: { servers: { go: server } } })).toBe(false);
        expect(declaresLspServers({})).toBe(false);
        expect(declaresLspServers(null)).toBe(false);
    });
});
