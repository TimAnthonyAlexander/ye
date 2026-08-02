import { describe, expect, test } from "bun:test";
import { ConfigValidationError, validateConfig } from "./validate.ts";

const base = {
    defaultProvider: "openrouter",
    providers: {
        openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
    },
    defaultModel: { provider: "openrouter", model: "~google/gemini-flash-latest" },
};

const withKeys = (extra: Record<string, unknown>): unknown => ({ ...base, ...extra });

describe("validateConfig compact", () => {
    test("passes all nine shaper tuning keys through", () => {
        const compact = {
            threshold: 0.5,
            defaultMaxTokens: 8000,
            minReplyTokens: 512,
            snipThreshold: 0.35,
            snipFloor: 0.3,
            snipProtectedTail: 8,
            snipMaxPerTurn: 10,
            microcompactThreshold: 0.42,
            microcompactHotTail: 6,
            microcompactMinBytes: 1024,
            collapseThreshold: 0.48,
            collapsePreserveRecent: 12,
        };
        expect(validateConfig(withKeys({ compact })).compact).toEqual(compact);
    });

    test("keeps optional keys absent when unset", () => {
        const out = validateConfig(withKeys({ compact: { threshold: 0.5 } }));
        expect(out.compact).toEqual({ threshold: 0.5 });
    });

    test("rejects fractions outside (0, 1]", () => {
        for (const key of [
            "snipThreshold",
            "snipFloor",
            "microcompactThreshold",
            "collapseThreshold",
        ]) {
            expect(() =>
                validateConfig(withKeys({ compact: { threshold: 0.5, [key]: 0 } })),
            ).toThrow(ConfigValidationError);
            expect(() =>
                validateConfig(withKeys({ compact: { threshold: 0.5, [key]: 1.5 } })),
            ).toThrow(ConfigValidationError);
        }
    });

    test("accepts 1 as an upper bound for fractions", () => {
        const out = validateConfig(withKeys({ compact: { threshold: 0.5, snipFloor: 1 } }));
        expect(out.compact?.snipFloor).toBe(1);
    });

    test("rejects non-integer and non-positive counts", () => {
        for (const key of [
            "snipProtectedTail",
            "snipMaxPerTurn",
            "microcompactHotTail",
            "microcompactMinBytes",
            "collapsePreserveRecent",
        ]) {
            expect(() =>
                validateConfig(withKeys({ compact: { threshold: 0.5, [key]: 2.5 } })),
            ).toThrow(ConfigValidationError);
            expect(() =>
                validateConfig(withKeys({ compact: { threshold: 0.5, [key]: 0 } })),
            ).toThrow(ConfigValidationError);
        }
    });

    test("rejects wrong-typed tuning keys", () => {
        expect(() =>
            validateConfig(withKeys({ compact: { threshold: 0.5, snipThreshold: "0.35" } })),
        ).toThrow(ConfigValidationError);
    });
});

describe("validateConfig format", () => {
    test("accepts enabled and formatters", () => {
        const format = { enabled: true, formatters: { "*.ts": "prettier --write $FILE" } };
        expect(validateConfig(withKeys({ format })).format).toEqual(format);
    });

    test("rejects a non-object formatters value", () => {
        expect(() => validateConfig(withKeys({ format: { formatters: ["prettier"] } }))).toThrow(
            ConfigValidationError,
        );
    });

    test("rejects a non-string formatter command", () => {
        expect(() => validateConfig(withKeys({ format: { formatters: { "*.ts": 3 } } }))).toThrow(
            ConfigValidationError,
        );
    });

    test("rejects an empty formatter key", () => {
        expect(() =>
            validateConfig(withKeys({ format: { formatters: { "": "prettier $FILE" } } })),
        ).toThrow(ConfigValidationError);
    });

    test("rejects a non-boolean enabled", () => {
        expect(() => validateConfig(withKeys({ format: { enabled: "yes" } }))).toThrow(
            ConfigValidationError,
        );
    });
});

describe("validateConfig verify", () => {
    test("accepts every field", () => {
        const verify = {
            enabled: true,
            lint: "bun run lint",
            test: "bun test",
            typecheck: "bun run typecheck",
            timeoutMs: 60000,
        };
        expect(validateConfig(withKeys({ verify })).verify).toEqual(verify);
    });

    test("rejects a non-string command", () => {
        expect(() => validateConfig(withKeys({ verify: { lint: 42 } }))).toThrow(
            ConfigValidationError,
        );
    });

    test("rejects a non-integer timeoutMs", () => {
        expect(() => validateConfig(withKeys({ verify: { timeoutMs: 1500.5 } }))).toThrow(
            ConfigValidationError,
        );
    });
});

describe("validateConfig budget", () => {
    test("accepts a non-integer maxUsd", () => {
        expect(validateConfig(withKeys({ budget: { maxUsd: 12.5 } })).budget).toEqual({
            maxUsd: 12.5,
        });
    });

    test("rejects a non-positive maxUsd", () => {
        expect(() => validateConfig(withKeys({ budget: { maxUsd: 0 } }))).toThrow(
            ConfigValidationError,
        );
    });

    test("rejects a non-number maxUsd", () => {
        expect(() => validateConfig(withKeys({ budget: { maxUsd: "10" } }))).toThrow(
            ConfigValidationError,
        );
    });
});

describe("validateConfig cheapModel", () => {
    test("accepts a provider/model pair at the root", () => {
        const cheapModel = { provider: "openrouter", model: "~google/gemini-flash-latest" };
        expect(validateConfig(withKeys({ cheapModel })).cheapModel).toEqual(cheapModel);
    });

    test("rejects a missing model", () => {
        expect(() => validateConfig(withKeys({ cheapModel: { provider: "openrouter" } }))).toThrow(
            ConfigValidationError,
        );
    });

    test("rejects a non-object", () => {
        expect(() => validateConfig(withKeys({ cheapModel: "haiku" }))).toThrow(
            ConfigValidationError,
        );
    });
});

describe("validateConfig suggestions", () => {
    test("accepts enabled", () => {
        expect(validateConfig(withKeys({ suggestions: { enabled: false } })).suggestions).toEqual({
            enabled: false,
        });
    });

    test("rejects a non-boolean enabled", () => {
        expect(() => validateConfig(withKeys({ suggestions: { enabled: 1 } }))).toThrow(
            ConfigValidationError,
        );
    });
});

describe("validateConfig lsp", () => {
    test("accepts servers with and without args", () => {
        const lsp = {
            enabled: true,
            servers: {
                typescript: { command: "typescript-language-server", args: ["--stdio"] },
                python: { command: "pyright-langserver" },
            },
        };
        expect(validateConfig(withKeys({ lsp })).lsp).toEqual(lsp);
    });

    test("rejects a server without a command", () => {
        expect(() =>
            validateConfig(withKeys({ lsp: { servers: { typescript: { args: ["--stdio"] } } } })),
        ).toThrow(ConfigValidationError);
    });

    test("rejects non-string args", () => {
        expect(() =>
            validateConfig(
                withKeys({ lsp: { servers: { typescript: { command: "tsls", args: [1] } } } }),
            ),
        ).toThrow(ConfigValidationError);
    });

    test("rejects a non-object servers", () => {
        expect(() => validateConfig(withKeys({ lsp: { servers: "typescript" } }))).toThrow(
            ConfigValidationError,
        );
    });

    test("rejects an empty language key", () => {
        expect(() =>
            validateConfig(withKeys({ lsp: { servers: { "": { command: "tsls" } } } })),
        ).toThrow(ConfigValidationError);
    });
});

describe("validateConfig permissions.persistSessionRules", () => {
    test("passes the flag through", () => {
        const out = validateConfig(
            withKeys({
                permissions: { defaultMode: "NORMAL", rules: [], persistSessionRules: true },
            }),
        );
        expect(out.permissions?.persistSessionRules).toBe(true);
    });

    test("rejects a non-boolean", () => {
        expect(() =>
            validateConfig(
                withKeys({
                    permissions: { defaultMode: "NORMAL", rules: [], persistSessionRules: "yes" },
                }),
            ),
        ).toThrow(ConfigValidationError);
    });

    test("stays undefined when unset", () => {
        const out = validateConfig(withKeys({ permissions: { defaultMode: "NORMAL", rules: [] } }));
        expect(out.permissions?.persistSessionRules).toBeUndefined();
    });
});

describe("validateConfig without the new keys", () => {
    test("validates and leaves every new block undefined", () => {
        const out = validateConfig(base);
        expect(out.defaultProvider).toBe("openrouter");
        expect(out.format).toBeUndefined();
        expect(out.verify).toBeUndefined();
        expect(out.budget).toBeUndefined();
        expect(out.cheapModel).toBeUndefined();
        expect(out.suggestions).toBeUndefined();
        expect(out.lsp).toBeUndefined();
    });
});
