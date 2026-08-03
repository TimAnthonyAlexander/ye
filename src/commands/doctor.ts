import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { effectiveSettings, resolveLspBinary } from "../config/detect.ts";
import { CONFIG_FILE, loadConfig } from "../config/index.ts";
import {
    CATALOGUE,
    checkPrerequisite,
    declinedLanguages,
    matchesProject,
} from "../lsp/install/index.ts";
import { resolveApiKey } from "../providers/index.ts";
import { YE_DIR } from "../storage/index.ts";
import { lspSearchDirs } from "../storage/paths.ts";
import { getCachedUpdateStatus } from "../update/check.ts";
import { CURRENT_VERSION } from "../update/version.ts";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

type Verdict = "pass" | "warn" | "fail";

interface Check {
    readonly name: string;
    readonly verdict: Verdict;
    readonly detail: string;
}

const checkRipgrep = (): Check => {
    const path = Bun.which("rg");
    return path
        ? { name: "ripgrep", verdict: "pass", detail: path }
        : {
              name: "ripgrep",
              verdict: "fail",
              detail: "not on PATH — Grep falls back to a slower scan",
          };
};

const checkConfig = async (): Promise<Check> => {
    try {
        await loadConfig();
        return { name: "config", verdict: "pass", detail: CONFIG_FILE };
    } catch (e) {
        return {
            name: "config",
            verdict: "fail",
            detail: `${CONFIG_FILE}: ${e instanceof Error ? e.message : String(e)}`,
        };
    }
};

const checkApiKey = (ctx: SlashCommandContext): Check => {
    const provCfg = ctx.config.providers[ctx.providerId];
    if (!provCfg) {
        return {
            name: "api key",
            verdict: "fail",
            detail: `provider ${ctx.providerId} is missing from config.providers`,
        };
    }
    if (ctx.providerId === "ollama") {
        return { name: "api key", verdict: "pass", detail: "ollama runs locally, no key needed" };
    }
    const key = resolveApiKey(provCfg);
    return key
        ? { name: "api key", verdict: "pass", detail: `${ctx.providerId} key resolved` }
        : {
              name: "api key",
              verdict: "fail",
              detail: `no key for ${ctx.providerId} (set $${provCfg.apiKeyEnv})`,
          };
};

const checkStorage = async (): Promise<Check> => {
    const probe = join(YE_DIR, ".doctor-probe");
    try {
        await mkdir(YE_DIR, { recursive: true });
        await writeFile(probe, "", "utf8");
        await unlink(probe);
        return { name: "storage", verdict: "pass", detail: `${YE_DIR} is writable` };
    } catch (e) {
        return {
            name: "storage",
            verdict: "fail",
            detail: `${YE_DIR}: ${e instanceof Error ? e.message : String(e)}`,
        };
    }
};

const checkVersion = async (): Promise<Check> => {
    const status = await getCachedUpdateStatus();
    if (!status) {
        return {
            name: "version",
            verdict: "warn",
            detail: `${CURRENT_VERSION}, update not checked yet`,
        };
    }
    return status.hasUpdate
        ? {
              name: "version",
              verdict: "warn",
              detail: `${CURRENT_VERSION} → ${status.latest} available (ye --update)`,
          }
        : { name: "version", verdict: "pass", detail: `${CURRENT_VERSION} is current` };
};

const effectiveLines = (ctx: SlashCommandContext): readonly string[] => {
    const entries = effectiveSettings(ctx.config, ctx.projectRoot);
    const width = Math.max(...entries.map((entry) => entry.key.length)) + 2;
    const heading =
        ctx.config.autoDetect === false
            ? "Effective settings (auto-detect off — explicit config only)"
            : "Effective settings";
    return [
        "",
        heading,
        ...entries.map(
            (entry) =>
                `  ${entry.key.padEnd(width)}${entry.value}${entry.origin ? ` (${entry.origin})` : ""}`,
        ),
    ];
};

const originOf = (path: string): string =>
    lspSearchDirs().some((dir) => path.startsWith(`${dir}${sep}`)) ? "Ye-installed" : "on PATH";

const serverCheck = (
    entry: (typeof CATALOGUE)[number],
    projectRoot: string,
    declined: ReadonlySet<string>,
): Check => {
    const candidates = [entry.binary, ...(entry.alternates ?? []).map((alt) => alt.binary)];
    for (const binary of candidates) {
        const path = resolveLspBinary(binary);
        if (path !== undefined) {
            return {
                name: entry.language,
                verdict: "pass",
                detail: `${binary} — ${path} (${originOf(path)})`,
            };
        }
    }

    const markers = entry.markers.join(" / ");
    if (!matchesProject(entry, projectRoot)) {
        return {
            name: entry.language,
            verdict: "pass",
            detail: `no ${markers} in this project — not needed`,
        };
    }

    const prerequisite = checkPrerequisite(entry);
    if (!prerequisite.ok) {
        return {
            name: entry.language,
            verdict: "fail",
            detail: `${markers} here but ${entry.binary} is missing — ${prerequisite.message}`,
        };
    }
    return {
        name: entry.language,
        verdict: "warn",
        detail: declined.has(entry.language)
            ? `${markers} here, ${entry.binary} declined — run /lsp install ${entry.language} to change your mind`
            : `${markers} here but ${entry.binary} is missing — run /lsp install ${entry.language}`,
    };
};

const languageServerLines = (ctx: SlashCommandContext): readonly string[] => {
    const declined = new Set(declinedLanguages());
    const checks = CATALOGUE.map((entry) => serverCheck(entry, ctx.projectRoot, declined));
    const width = Math.max(...checks.map((check) => check.name.length)) + 2;

    const notes: string[] = [];
    if (ctx.config.lsp?.enabled === false) {
        notes.push("  lsp.enabled is false — the navigation tools are off whatever is installed");
    }
    if (ctx.config.autoDetect === false) {
        notes.push("  autoDetect is false — only servers listed in lsp.servers are used");
    }
    if (ctx.config.lsp?.autoInstall === false) {
        notes.push("  lsp.autoInstall is false — Ye will not offer to install a missing server");
    }

    return [
        "",
        "Language servers",
        ...notes,
        ...checks.map((check) => `  [${check.verdict}] ${check.name.padEnd(width)}${check.detail}`),
    ];
};

export const DoctorCommand: SlashCommand = {
    name: "doctor",
    description:
        "Check the local environment: ripgrep, config, key, storage, version, language servers.",
    execute: async (_args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const checks: readonly Check[] = [
            checkRipgrep(),
            await checkConfig(),
            checkApiKey(ctx),
            await checkStorage(),
            await checkVersion(),
        ];
        const failed = checks.filter((c) => c.verdict === "fail").length;
        const lines = checks.map((c) => `  [${c.verdict}] ${c.name.padEnd(9)}${c.detail}`);
        const summary = failed === 0 ? "all checks passed" : `${failed} check(s) failed`;
        ctx.addSystemMessage(
            [
                "Doctor",
                ...lines,
                `  ${summary}`,
                ...effectiveLines(ctx),
                ...languageServerLines(ctx),
            ].join("\n"),
        );
        return { kind: "ok" };
    },
};
