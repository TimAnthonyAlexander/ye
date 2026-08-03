import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults.ts";
import type { Config, LspConfig } from "../../config/types.ts";
import type { Which } from "./catalogue.ts";
import { pendingOffers, type OfferOptions } from "./offer.ts";
import { clearDecline, declinedLanguages, isDeclined, recordDecline } from "./state.ts";

const whichOf =
    (...available: readonly string[]): Which =>
    (binary) =>
        available.includes(binary) ? `/usr/bin/${binary}` : null;

const NOTHING_ON_PATH: Which = () => null;

let dir: string;
let projectRoot: string;
let statePath: string;

const configWith = (lsp?: LspConfig, autoDetect?: boolean): Config => ({
    ...DEFAULT_CONFIG,
    ...(lsp !== undefined ? { lsp } : {}),
    ...(autoDetect !== undefined ? { autoDetect } : {}),
});

const opts = (overrides: Partial<OfferOptions> = {}): OfferOptions => ({
    interactive: true,
    statePath,
    which: whichOf("bun", "npm", "go", "rustup"),
    resolveBinary: () => undefined,
    ...overrides,
});

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ye-lsp-offer-"));
    projectRoot = join(dir, "project");
    statePath = join(dir, "state", "state.json");
    mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("decline state", () => {
    test("a missing file reads as no declines", () => {
        expect(declinedLanguages(statePath)).toEqual([]);
        expect(isDeclined("typescript", statePath)).toBe(false);
    });

    test("a decline round-trips and clears", () => {
        recordDecline("typescript", statePath);
        recordDecline("go", statePath);
        expect(declinedLanguages(statePath)).toEqual(["typescript", "go"]);

        clearDecline("typescript", statePath);
        expect(declinedLanguages(statePath)).toEqual(["go"]);
        expect(isDeclined("typescript", statePath)).toBe(false);
    });

    test("recording the same language twice is idempotent", () => {
        recordDecline("rust", statePath);
        recordDecline("rust", statePath);
        expect(declinedLanguages(statePath)).toEqual(["rust"]);
    });

    test("clearing a language that was never declined is a no-op", () => {
        clearDecline("python", statePath);
        expect(declinedLanguages(statePath)).toEqual([]);
    });

    test("an empty file reads as no declines", () => {
        mkdirSync(join(dir, "state"), { recursive: true });
        writeFileSync(statePath, "");
        expect(declinedLanguages(statePath)).toEqual([]);
    });

    test("a corrupt file reads as no declines and is still writable", () => {
        mkdirSync(join(dir, "state"), { recursive: true });
        writeFileSync(statePath, "{ this is not json");
        expect(declinedLanguages(statePath)).toEqual([]);

        recordDecline("go", statePath);
        expect(declinedLanguages(statePath)).toEqual(["go"]);
    });

    test("a file of the wrong shape reads as no declines", () => {
        mkdirSync(join(dir, "state"), { recursive: true });
        writeFileSync(statePath, JSON.stringify({ declined: "typescript" }));
        expect(declinedLanguages(statePath)).toEqual([]);
    });

    test("writing leaves no temp file behind", () => {
        recordDecline("typescript", statePath);
        clearDecline("typescript", statePath);
        expect(readdirSync(join(dir, "state"))).toEqual(["state.json"]);
    });
});

describe("pendingOffers", () => {
    test("a matching project with a missing binary and a present prerequisite offers once", () => {
        writeFileSync(join(projectRoot, "tsconfig.json"), "{}");
        const offers = pendingOffers(configWith(), projectRoot, opts());

        expect(offers).toHaveLength(1);
        const offer = offers[0];
        expect(offer?.language).toBe("typescript");
        expect(offer?.scope).toBe("ye");
        expect(offer?.command).toContain("typescript-language-server");
        expect(offer?.note).toContain("~/.ye/lsp");
    });

    test("a project with no marker offers nothing", () => {
        expect(pendingOffers(configWith(), projectRoot, opts())).toEqual([]);
    });

    test("interactive false offers nothing even when everything else is satisfied", () => {
        writeFileSync(join(projectRoot, "tsconfig.json"), "{}");
        expect(pendingOffers(configWith(), projectRoot, opts({ interactive: false }))).toEqual([]);
    });

    test("lsp.autoInstall false offers nothing", () => {
        writeFileSync(join(projectRoot, "tsconfig.json"), "{}");
        const config = configWith({ autoInstall: false });
        expect(pendingOffers(config, projectRoot, opts())).toEqual([]);
    });

    test("lsp.enabled false offers nothing", () => {
        writeFileSync(join(projectRoot, "tsconfig.json"), "{}");
        expect(pendingOffers(configWith({ enabled: false }), projectRoot, opts())).toEqual([]);
    });

    test("autoDetect false offers nothing", () => {
        writeFileSync(join(projectRoot, "tsconfig.json"), "{}");
        expect(pendingOffers(configWith(undefined, false), projectRoot, opts())).toEqual([]);
    });

    test("a resolvable binary offers nothing", () => {
        writeFileSync(join(projectRoot, "tsconfig.json"), "{}");
        const resolveBinary = (binary: string): string | undefined =>
            binary === "typescript-language-server" ? "/usr/local/bin/tsls" : undefined;
        expect(pendingOffers(configWith(), projectRoot, opts({ resolveBinary }))).toEqual([]);
    });

    test("a resolvable alternate offers nothing", () => {
        writeFileSync(join(projectRoot, "pyproject.toml"), "");
        const resolveBinary = (binary: string): string | undefined =>
            binary === "pylsp" ? "/usr/local/bin/pylsp" : undefined;
        expect(pendingOffers(configWith(), projectRoot, opts({ resolveBinary }))).toEqual([]);
    });

    test("a missing prerequisite offers nothing", () => {
        writeFileSync(join(projectRoot, "go.mod"), "module x\n");
        expect(pendingOffers(configWith(), projectRoot, opts({ which: NOTHING_ON_PATH }))).toEqual(
            [],
        );
    });

    test("a decline suppresses the offer and clearDecline restores it", () => {
        writeFileSync(join(projectRoot, "tsconfig.json"), "{}");
        recordDecline("typescript", statePath);
        expect(pendingOffers(configWith(), projectRoot, opts())).toEqual([]);

        clearDecline("typescript", statePath);
        expect(pendingOffers(configWith(), projectRoot, opts())).toHaveLength(1);
    });

    test("a corrupt state file suppresses nothing", () => {
        writeFileSync(join(projectRoot, "tsconfig.json"), "{}");
        mkdirSync(join(dir, "state"), { recursive: true });
        writeFileSync(statePath, "not json at all");
        expect(pendingOffers(configWith(), projectRoot, opts())).toHaveLength(1);
    });

    test("a toolchain offer says it is not removed with ~/.ye/lsp", () => {
        writeFileSync(join(projectRoot, "Cargo.toml"), "");
        const offers = pendingOffers(configWith(), projectRoot, opts());

        expect(offers).toHaveLength(1);
        const offer = offers[0];
        expect(offer?.language).toBe("rust");
        expect(offer?.scope).toBe("toolchain");
        expect(offer?.note).toContain("rustup toolchain");
        expect(offer?.note).toContain("will not remove it");
        expect(offer?.command).toBe("rustup component add rust-analyzer");
    });

    test("two matching languages yield two offers", () => {
        writeFileSync(join(projectRoot, "tsconfig.json"), "{}");
        writeFileSync(join(projectRoot, "go.mod"), "module x\n");
        expect(pendingOffers(configWith(), projectRoot, opts()).map((o) => o.language)).toEqual([
            "typescript",
            "go",
        ]);
    });
});
