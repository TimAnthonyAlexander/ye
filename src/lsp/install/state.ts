import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LSP_STATE_FILE } from "../../storage/paths.ts";

export interface LspInstallState {
    readonly declined: readonly string[];
}

const EMPTY: LspInstallState = { declined: [] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// A preference cache, not data worth failing a session over: a missing, empty,
// truncated or hand-mangled file reads as "nothing declined".
export const readState = (path: string = LSP_STATE_FILE): LspInstallState => {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch {
        return EMPTY;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return EMPTY;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed["declined"])) return EMPTY;
    return {
        declined: parsed["declined"].filter(
            (language): language is string => typeof language === "string" && language.length > 0,
        ),
    };
};

const writeState = (state: LspInstallState, path: string): void => {
    const dir = dirname(path);
    const temp = join(dir, `.${process.pid}-${Date.now()}.tmp`);
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
        renameSync(temp, path);
    } catch {
        rmSync(temp, { force: true });
    }
};

export const declinedLanguages = (path: string = LSP_STATE_FILE): readonly string[] =>
    readState(path).declined;

export const isDeclined = (language: string, path: string = LSP_STATE_FILE): boolean =>
    readState(path).declined.includes(language);

export const recordDecline = (language: string, path: string = LSP_STATE_FILE): void => {
    const declined = readState(path).declined;
    if (declined.includes(language)) return;
    writeState({ declined: [...declined, language] }, path);
};

export const clearDecline = (language: string, path: string = LSP_STATE_FILE): void => {
    const declined = readState(path).declined;
    if (!declined.includes(language)) return;
    writeState({ declined: declined.filter((entry) => entry !== language) }, path);
};
