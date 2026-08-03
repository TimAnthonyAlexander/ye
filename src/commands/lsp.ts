import { resolveLspBinary } from "../config/detect.ts";
import { invalidateLspAvailability } from "../lsp/availability.ts";
import {
    CATALOGUE,
    checkPrerequisite,
    clearDecline,
    entryFor,
    installCommandFor,
    installServer,
    isDeclined,
    matchesProject,
    resolveServerBinary,
    uninstallCommandFor,
    uninstallServer,
    type InstallOptions,
    type InstallResult,
    type PrerequisiteResult,
    type ServerEntry,
    type UninstallResult,
} from "../lsp/install/index.ts";
import type { OutputSink, SlashCommand, SlashCommandContext, SlashCommandResult } from "./types.ts";

const LANGUAGES = CATALOGUE.map((entry) => entry.language);
const KNOWN = `Known languages: ${LANGUAGES.join(", ")}.`;
const USAGE = "/lsp · /lsp install <language> · /lsp uninstall <language>";

export type LspAction =
    | { readonly kind: "status" }
    | { readonly kind: "install"; readonly language: string }
    | { readonly kind: "uninstall"; readonly language: string }
    | { readonly kind: "error"; readonly message: string };

export const parseLspArgs = (args: string): LspAction => {
    const words = args
        .trim()
        .split(/\s+/)
        .filter((word) => word.length > 0);
    const verb = words[0];
    if (verb === undefined || verb === "status") {
        return words.length > 1
            ? { kind: "error", message: `\`/lsp ${verb}\` takes no arguments. Usage: ${USAGE}` }
            : { kind: "status" };
    }
    if (verb !== "install" && verb !== "uninstall") {
        return { kind: "error", message: `Unknown subcommand \`${verb}\`. Usage: ${USAGE}` };
    }
    if (words.length > 2) {
        return { kind: "error", message: `\`/lsp ${verb}\` takes one language. ${KNOWN}` };
    }
    const language = words[1]?.toLowerCase();
    if (language === undefined) {
        return { kind: "error", message: `\`/lsp ${verb}\` needs a language. ${KNOWN}` };
    }
    if (entryFor(language) === undefined) {
        return { kind: "error", message: `No language server for \`${language}\`. ${KNOWN}` };
    }
    return { kind: verb, language };
};

export type ServerSource = "ye" | "path";

export interface LanguageStatus {
    readonly language: string;
    readonly displayName: string;
    readonly matched: boolean;
    readonly serverPath: string | null;
    readonly serverSource: ServerSource | null;
    readonly declined: boolean;
    readonly prerequisiteMissing: string | null;
    readonly installCommand: string;
}

const DETAIL = " ".repeat(13);

const verdictOf = (row: LanguageStatus): string =>
    row.serverPath !== null
        ? "ready"
        : row.declined
          ? "declined"
          : row.prerequisiteMissing !== null
            ? "blocked"
            : "missing";

export const statusLines = (rows: readonly LanguageStatus[]): readonly string[] => {
    const lines: string[] = ["Language servers"];
    for (const row of rows) {
        lines.push(
            `  [${verdictOf(row)}]`.padEnd(13) + `${row.language.padEnd(12)}${row.displayName}`,
        );
        lines.push(`${DETAIL}project ${row.matched ? "matches" : "no match"}`);
        lines.push(
            row.serverPath === null
                ? `${DETAIL}server  not found`
                : `${DETAIL}server  ${row.serverPath} (${row.serverSource === "ye" ? "installed by Ye" : "on PATH"})`,
        );
        if (row.serverPath !== null) continue;
        if (row.prerequisiteMissing !== null) {
            lines.push(`${DETAIL}blocked ${row.prerequisiteMissing}`);
            continue;
        }
        lines.push(`${DETAIL}install ${row.installCommand}`);
        if (row.declined) {
            lines.push(`${DETAIL}declined — /lsp install ${row.language} still works`);
        }
    }
    lines.push(`  ${USAGE}`);
    return lines;
};

export interface ServerLocation {
    readonly path: string;
    readonly source: ServerSource;
}

const findServer = (entry: ServerEntry): ServerLocation | null => {
    const owned = resolveServerBinary(entry);
    if (owned !== undefined) return { path: owned.path, source: owned.source };
    const candidates = [entry.binary, ...(entry.alternates ?? []).map((alt) => alt.binary)];
    for (const candidate of candidates) {
        const found = resolveLspBinary(candidate);
        if (found !== undefined) return { path: found, source: "path" };
    }
    return null;
};

const statusFor = (entry: ServerEntry, projectRoot: string): LanguageStatus => {
    const server = findServer(entry);
    const prerequisite = checkPrerequisite(entry);
    return {
        language: entry.language,
        displayName: entry.displayName,
        matched: matchesProject(entry, projectRoot),
        serverPath: server?.path ?? null,
        serverSource: server?.source ?? null,
        declined: isDeclined(entry.language),
        prerequisiteMissing: prerequisite.ok ? null : prerequisite.message,
        installCommand: installCommandFor(entry.language) ?? "",
    };
};

export interface LspRuntime {
    readonly install: (language: string, opts: InstallOptions) => Promise<InstallResult>;
    readonly uninstall: (language: string, opts: InstallOptions) => Promise<UninstallResult>;
    readonly invalidate: () => void;
    readonly collect: (projectRoot: string) => readonly LanguageStatus[];
    readonly locate: (entry: ServerEntry) => ServerLocation | null;
    readonly prerequisite: (entry: ServerEntry) => PrerequisiteResult;
}

export const defaultRuntime: LspRuntime = {
    install: installServer,
    uninstall: uninstallServer,
    invalidate: () => invalidateLspAvailability(),
    collect: (projectRoot) => CATALOGUE.map((entry) => statusFor(entry, projectRoot)),
    locate: findServer,
    prerequisite: (entry) => checkPrerequisite(entry),
};

// Everything a language-server install needs from the UI. SlashCommandContext
// satisfies it structurally, so the session-start offer can drive the same
// install without assembling a whole command context.
export interface InstallSurface {
    addSystemMessage(text: string): void;
    streamOutput(): OutputSink;
}

const tail = (output: string, count = 20): readonly string[] => {
    const lines = output.split("\n").filter((line) => line.length > 0);
    return lines.length <= count ? lines : lines.slice(lines.length - count);
};

// Consent is the caller's job: /lsp install confirms with a picker, the
// session-start offer confirms with its own. Nothing here asks, so nothing here
// may be reached without an explicit yes.
export const runInstall = async (
    language: string,
    surface: InstallSurface,
    rt: LspRuntime = defaultRuntime,
): Promise<SlashCommandResult> => {
    const entry = entryFor(language);
    if (entry === undefined) {
        return { kind: "error", message: `No language server for \`${language}\`. ${KNOWN}` };
    }

    const sink = surface.streamOutput();
    let result: InstallResult;
    try {
        result = await rt.install(entry.language, { onProgress: (line) => sink.write(line) });
    } finally {
        sink.close();
    }

    if (!result.ok) {
        surface.addSystemMessage(
            [`Install failed: ${result.error ?? "unknown error"}`, ...tail(result.output)].join(
                "\n",
            ),
        );
        return { kind: "error", message: result.error ?? "install failed" };
    }

    rt.invalidate();
    clearDecline(entry.language);
    surface.addSystemMessage(
        [
            `Installed ${entry.binary} at ${result.path}.`,
            "Definition, References and SymbolSearch are live on the next turn — no restart.",
        ].join("\n"),
    );
    return { kind: "ok" };
};

const confirmInstall = async (entry: ServerEntry, ctx: SlashCommandContext): Promise<boolean> => {
    const command = installCommandFor(entry.language);
    if (command === undefined) return false;
    ctx.addSystemMessage(
        [
            `Install ${entry.displayName}`,
            `  command  ${command}`,
            `  scope    ${entry.scope === "ye" ? "Ye's own directory (~/.ye/lsp)" : "your toolchain — Ye does not own it"}`,
            `  removal  ${entry.uninstall}`,
        ].join("\n"),
    );
    const choice = await ctx.pick({
        title: "Run this command now?",
        options: [
            { id: "install", label: "Yes, run it", description: command },
            { id: "cancel", label: "Cancel", description: "nothing is installed" },
        ],
        initialId: "cancel",
    });
    return choice === "install";
};

const doUninstall = async (
    entry: ServerEntry,
    ctx: SlashCommandContext,
    rt: LspRuntime,
): Promise<SlashCommandResult> => {
    const command = uninstallCommandFor(entry.language);

    if (entry.scope === "toolchain") {
        ctx.addSystemMessage(
            [
                `Ye will not uninstall ${entry.displayName}.`,
                `  ${entry.uninstall}`,
                ...(command === undefined ? [] : [`  run it yourself: ${command}`]),
            ].join("\n"),
        );
        return { kind: "ok" };
    }

    ctx.addSystemMessage(
        [
            `Uninstall ${entry.displayName}`,
            `  ${entry.uninstall}`,
            ...(command === undefined ? [] : [`  command  ${command}`]),
        ].join("\n"),
    );
    const choice = await ctx.pick({
        title: "Remove it now?",
        options: [
            { id: "uninstall", label: "Yes, remove it", description: command ?? entry.binary },
            { id: "cancel", label: "Cancel", description: "nothing is removed" },
        ],
        initialId: "cancel",
    });
    if (choice !== "uninstall") {
        ctx.addSystemMessage("Cancelled — nothing was removed.");
        return { kind: "ok" };
    }

    const sink = ctx.streamOutput();
    let result: UninstallResult;
    try {
        result = await rt.uninstall(entry.language, { onProgress: (line) => sink.write(line) });
    } finally {
        sink.close();
    }

    if (!result.ok) {
        ctx.addSystemMessage(
            [
                `Uninstall failed: ${result.error ?? "unknown error"}`,
                ...(result.manual === undefined ? [] : [`  run it yourself: ${result.manual}`]),
                ...tail(result.output),
            ].join("\n"),
        );
        return { kind: "error", message: result.error ?? "uninstall failed" };
    }

    rt.invalidate();
    ctx.addSystemMessage(`Removed the ${entry.language} language server. ${result.output}`);
    return { kind: "ok" };
};

const showStatus = (ctx: SlashCommandContext, rt: LspRuntime): SlashCommandResult => {
    const notes: string[] = [];
    if (ctx.config.lsp?.enabled === false) {
        notes.push("  lsp.enabled is false — the navigation tools stay off whatever is installed.");
    }
    if (ctx.config.lsp?.autoInstall === false) {
        notes.push(
            "  lsp.autoInstall is false — Ye never offers to install; /lsp install still works.",
        );
    }
    ctx.addSystemMessage([...statusLines(rt.collect(ctx.projectRoot)), ...notes].join("\n"));
    return { kind: "ok" };
};

export const buildLspCommand = (rt: LspRuntime): SlashCommand => ({
    name: "lsp",
    description: "Show language server status, or install and remove one.",
    usage: "/lsp [install|uninstall] [language]",
    execute: async (args: string, ctx: SlashCommandContext): Promise<SlashCommandResult> => {
        const action = parseLspArgs(args);
        if (action.kind === "error") return { kind: "error", message: action.message };
        if (action.kind === "status") return showStatus(ctx, rt);

        const entry = entryFor(action.language);
        if (entry === undefined) {
            return {
                kind: "error",
                message: `No language server for \`${action.language}\`. ${KNOWN}`,
            };
        }
        if (action.kind === "uninstall") return await doUninstall(entry, ctx, rt);

        const existing = rt.locate(entry);
        if (existing !== null) {
            ctx.addSystemMessage(
                `${entry.displayName} is already available at ${existing.path}. Nothing to install.`,
            );
            return { kind: "ok" };
        }
        const prerequisite = rt.prerequisite(entry);
        if (!prerequisite.ok) {
            ctx.addSystemMessage(prerequisite.message);
            return { kind: "ok" };
        }
        if (!(await confirmInstall(entry, ctx))) {
            ctx.addSystemMessage("Cancelled — nothing was installed.");
            return { kind: "ok" };
        }
        return await runInstall(entry.language, ctx, rt);
    },
});

export const LspCommand = buildLspCommand(defaultRuntime);
