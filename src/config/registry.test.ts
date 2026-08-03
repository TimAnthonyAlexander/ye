import { describe, expect, test } from "bun:test";
import {
    adjust,
    buildRows,
    CONFIG_FIELDS,
    fieldByPath,
    formatValue,
    isSelectableRow,
    parseInput,
    resolveField,
    SECTION_ORDER,
    type ConfigField,
    type ConfigValue,
    type InfoRow,
} from "./registry.ts";
import { validateConfig } from "./validate.ts";

const field = (path: string): ConfigField => {
    const found = fieldByPath(path);
    if (!found) throw new Error(`no field ${path}`);
    return found;
};

describe("registry shape", () => {
    test("every path is unique", () => {
        const paths = CONFIG_FIELDS.map((f) => f.path);
        expect(new Set(paths).size).toBe(paths.length);
    });

    test("every section is in SECTION_ORDER", () => {
        for (const f of CONFIG_FIELDS) expect(SECTION_ORDER).toContain(f.section);
    });

    test("every default satisfies its own spec", () => {
        for (const f of CONFIG_FIELDS) {
            const value = f.defaultValue;
            if (value === undefined) continue;
            const spec = f.spec;
            if (spec.kind === "boolean") expect(typeof value).toBe("boolean");
            if (spec.kind === "string") expect(typeof value).toBe("string");
            if (spec.kind === "enum") expect(spec.options).toContain(value as string);
            if (spec.kind === "number") {
                expect(value).toBeGreaterThanOrEqual(spec.min);
                expect(value).toBeLessThanOrEqual(spec.max);
            }
        }
    });

    test("labels are the leaf of the path", () => {
        for (const f of CONFIG_FIELDS) {
            if (!f.path.includes(".")) continue;
            expect(f.path.endsWith(`.${f.label}`)).toBe(true);
        }
    });

    // A registry entry that the validator rejects would brick the config on the
    // next launch, so every field is round-tripped through validateConfig at
    // both ends of its range.
    test("min and max of every field pass validateConfig", () => {
        const base = {
            defaultProvider: "openrouter",
            providers: { openrouter: { baseUrl: "u", apiKeyEnv: "K" } },
            defaultModel: { provider: "openrouter", model: "m" },
        };
        const candidates = (f: ConfigField): readonly ConfigValue[] => {
            const spec = f.spec;
            if (spec.kind === "boolean") return [true, false];
            if (spec.kind === "enum") return spec.options;
            if (spec.kind === "number") return [spec.min, spec.max];
            return ["a command"];
        };
        for (const f of CONFIG_FIELDS) {
            for (const value of candidates(f)) {
                const segments = f.path.split(".");
                const raw: Record<string, unknown> = { ...base };
                if (segments.length === 1) {
                    raw[f.path] = value;
                } else {
                    const [block, leaf] = segments as [string, string];
                    const existing = raw[block];
                    raw[block] = {
                        ...(typeof existing === "object" && existing !== null ? existing : {}),
                        [leaf]: value,
                    };
                }
                if (raw["maxTurns"] !== undefined) {
                    raw["maxTurns"] = { master: 1, subagent: 1, ...(raw["maxTurns"] as object) };
                }
                if (raw["permissions"] !== undefined) {
                    raw["permissions"] = {
                        defaultMode: "NORMAL",
                        rules: [],
                        ...(raw["permissions"] as object),
                    };
                }
                if (raw["compact"] !== undefined) {
                    raw["compact"] = { threshold: 0.5, ...(raw["compact"] as object) };
                }
                expect(() => validateConfig(raw)).not.toThrow();
            }
        }
    });
});

describe("resolveField origin", () => {
    test("a key present in the raw file is configured", () => {
        const row = resolveField(field("verify.typecheck"), { verify: { typecheck: "tsc" } }, {});
        expect(row.value).toBe("tsc");
        expect(row.origin).toBe("configured");
    });

    test("a value only in the detection overlay is detected", () => {
        const row = resolveField(field("verify.typecheck"), {}, { "verify.typecheck": "bun tsc" });
        expect(row.value).toBe("bun tsc");
        expect(row.origin).toBe("detected");
    });

    test("configured beats detected", () => {
        const row = resolveField(
            field("verify.typecheck"),
            { verify: { typecheck: "mine" } },
            { "verify.typecheck": "detected" },
        );
        expect(row.value).toBe("mine");
        expect(row.origin).toBe("configured");
    });

    test("neither present falls back to the registry default", () => {
        const row = resolveField(field("compact.threshold"), {}, {});
        expect(row.value).toBe(0.5);
        expect(row.origin).toBe("default");
    });

    test("a field with no default reads as unset", () => {
        const row = resolveField(field("budget.maxUsd"), {}, {});
        expect(row.value).toBeUndefined();
        expect(formatValue(row.value)).toBe("unset");
    });

    test("a raw value of the wrong type is ignored", () => {
        const row = resolveField(
            field("gitStatus.maxLines"),
            { gitStatus: { maxLines: "30" } },
            {},
        );
        expect(row.value).toBe(30);
        expect(row.origin).toBe("default");
    });
});

describe("buildRows", () => {
    const infos: readonly InfoRow[] = [
        { kind: "info", section: "permissions", label: "rules", value: "3 rules", note: "n" },
    ];

    test("groups fields under their section header in SECTION_ORDER", () => {
        const rows = buildRows({}, {}, infos);
        const headers = rows.filter((r) => r.kind === "header").map((r) => r.label);
        expect(headers).toEqual(SECTION_ORDER.filter((s) => headers.includes(s)));
        expect(headers[0]).toBe("model");
    });

    test("info rows land in their own section and are not selectable", () => {
        const rows = buildRows({}, {}, infos);
        const index = rows.findIndex((r) => r.kind === "info");
        expect(index).toBeGreaterThan(0);
        const row = rows[index];
        expect(row && isSelectableRow(row)).toBe(false);
        const headerBefore = rows
            .slice(0, index)
            .reverse()
            .find((r) => r.kind === "header");
        expect(headerBefore?.label).toBe("permissions");
    });

    test("every registry field gets exactly one row", () => {
        const rows = buildRows({}, {}, []);
        expect(rows.filter(isSelectableRow).length).toBe(CONFIG_FIELDS.length);
    });
});

describe("adjust", () => {
    test("booleans toggle in both directions", () => {
        const f = field("gitStatus.enabled");
        expect(adjust(f, true, 1)).toBe(false);
        expect(adjust(f, false, -1)).toBe(true);
    });

    test("enums wrap", () => {
        const f = field("permissions.defaultMode");
        expect(adjust(f, "AUTO", 1)).toBe("NORMAL");
        expect(adjust(f, "PLAN", 1)).toBe("AUTO");
        expect(adjust(f, "AUTO", -1)).toBe("PLAN");
    });

    test("an enum with no default cycles through unset", () => {
        const f = field("defaultModel.providerSort");
        expect(adjust(f, undefined, 1)).toBe("price");
        expect(adjust(f, "price", -1)).toBeUndefined();
        expect(adjust(f, "latency", 1)).toBeUndefined();
    });

    test("numbers step and clamp to the field range", () => {
        const f = field("maxTurns.master");
        expect(adjust(f, 100, 1)).toBe(105);
        expect(adjust(f, 100, -1)).toBe(95);
        expect(adjust(f, 500, 1)).toBe(500);
        expect(adjust(f, 1, -1)).toBe(1);
    });

    test("fractional steps stay on the grid", () => {
        const f = field("compact.threshold");
        expect(adjust(f, 0.5, 1)).toBe(0.55);
        expect(adjust(f, 0.55, 1)).toBe(0.6);
    });

    test("an off-grid value snaps toward the arrow before stepping", () => {
        const f = field("compact.threshold");
        expect(adjust(f, 0.42, -1)).toBe(0.4);
        expect(adjust(f, 0.42, 1)).toBe(0.45);
    });

    test("an optional number drops to unset below its minimum", () => {
        const f = field("budget.maxUsd");
        expect(adjust(f, undefined, 1)).toBe(0.5);
        expect(adjust(f, 0.5, -1)).toBeUndefined();
        expect(adjust(f, undefined, -1)).toBeUndefined();
    });

    test("strings ignore the arrows", () => {
        const f = field("verify.test");
        expect(adjust(f, "bun test", 1)).toBe("bun test");
        expect(adjust(f, undefined, -1)).toBeUndefined();
    });
});

describe("parseInput", () => {
    test("a string field takes the trimmed text", () => {
        expect(parseInput(field("verify.test"), "  bun test  ")).toEqual({
            ok: true,
            value: "bun test",
        });
    });

    test("an empty string clears the key", () => {
        expect(parseInput(field("verify.test"), "   ")).toEqual({ ok: true, value: undefined });
    });

    test("a number is clamped and rounded to the spec", () => {
        expect(parseInput(field("maxTurns.master"), "9999")).toEqual({ ok: true, value: 500 });
        expect(parseInput(field("maxTurns.master"), "7.6")).toEqual({ ok: true, value: 8 });
    });

    test("junk is rejected", () => {
        const result = parseInput(field("maxTurns.master"), "abc");
        expect(result.ok).toBe(false);
    });

    test("an empty number is unset only when the field has no default", () => {
        expect(parseInput(field("budget.maxUsd"), "")).toEqual({ ok: true, value: undefined });
        expect(parseInput(field("maxTurns.master"), "").ok).toBe(false);
    });
});
