import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveLspBinary } from "../../config/detect.ts";
import type { Config } from "../../config/types.ts";
import { LSP_STATE_FILE } from "../../storage/paths.ts";
import {
    CATALOGUE,
    checkPrerequisite,
    defaultWhich,
    installCommandFor,
    type InstallScope,
    type ServerEntry,
    type Which,
} from "./catalogue.ts";
import { declinedLanguages } from "./state.ts";

export interface InstallOffer {
    readonly language: string;
    readonly displayName: string;
    readonly command: string;
    readonly scope: InstallScope;
    readonly note: string;
}

export interface OfferOptions {
    readonly interactive: boolean;
    readonly statePath?: string;
    readonly which?: Which;
    readonly resolveBinary?: (command: string) => string | undefined;
}

export const matchesProject = (entry: ServerEntry, projectRoot: string): boolean =>
    entry.markers.some((marker) => existsSync(join(projectRoot, marker)));

const YE_LSP = "~/.ye/lsp";

const noteFor = (entry: ServerEntry): string => {
    const plan = entry.install;
    switch (plan.kind) {
        case "node":
            return `Installs ${plan.packages.join(" and ")} into Ye's own package root at ${YE_LSP}/node. Removable: deleting ${YE_LSP} undoes it, nothing outside it is touched.`;
        case "go":
            return `Builds ${plan.module} into ${YE_LSP}/bin. Removable: deleting ${YE_LSP} undoes it, nothing outside it is touched.`;
        case "rustup":
            return `Adds the ${plan.component} component to your rustup toolchain, NOT to ${YE_LSP}. Deleting ${YE_LSP} will not remove it — only \`rustup component remove ${plan.component}\` will.`;
    }
};

export const offerFor = (entry: ServerEntry, which: Which): InstallOffer | undefined => {
    const command = installCommandFor(entry.language, { which });
    return command === undefined
        ? undefined
        : {
              language: entry.language,
              displayName: entry.displayName,
              command,
              scope: entry.scope,
              note: noteFor(entry),
          };
};

// Every gate here is a reason to stay silent. Ye may only ever ASK; nothing in
// this module installs anything, and a suppressed offer costs the user nothing
// but a language server they did not ask for.
export const pendingOffers = (
    config: Config,
    projectRoot: string,
    opts: OfferOptions,
): readonly InstallOffer[] => {
    if (!opts.interactive) return [];
    if (config.lsp?.autoInstall === false) return [];
    if (config.lsp?.enabled === false) return [];
    if (config.autoDetect === false) return [];

    const which = opts.which ?? defaultWhich;
    const resolve = opts.resolveBinary ?? resolveLspBinary;
    const declined = new Set(declinedLanguages(opts.statePath ?? LSP_STATE_FILE));

    return CATALOGUE.flatMap((entry) => {
        if (!matchesProject(entry, projectRoot)) return [];
        if (declined.has(entry.language)) return [];
        const candidates = [entry.binary, ...(entry.alternates ?? []).map((alt) => alt.binary)];
        if (candidates.some((binary) => resolve(binary) !== undefined)) return [];
        if (!checkPrerequisite(entry, which).ok) return [];
        const offer = offerFor(entry, which);
        return offer === undefined ? [] : [offer];
    });
};
