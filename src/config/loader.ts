import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_CONFIG } from "./defaults.ts";
import { CONFIG_FILE } from "./paths.ts";
import type { Config, PermissionRule } from "./types.ts";
import { validateConfig } from "./validate.ts";

export interface LoadResult {
    readonly config: Config;
    readonly path: string;
    readonly created: boolean;
}

// Temp file + rename: a crash mid-write leaves the previous config intact
// instead of a truncated file that fails validation on next launch. The mode is
// tightened on the temp file, before it becomes visible under the real name.
const writeAtomic = async (path: string, contents: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
        await Bun.write(tmp, contents);
        // Providers persist API keys here. Best-effort: Windows and some FS
        // layouts ignore POSIX modes.
        await chmod(tmp, 0o600).catch(() => {});
        await rename(tmp, path);
    } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
    }
};

const writeConfig = (path: string, config: Config): Promise<void> =>
    writeAtomic(path, `${JSON.stringify(config, null, 2)}\n`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const sameRule = (a: unknown, b: PermissionRule): boolean =>
    isRecord(a) && a["effect"] === b.effect && a["tool"] === b.tool && a["pattern"] === b.pattern;

export const withPermissionRule = (config: Config, rule: PermissionRule): Config => {
    const permissions = config.permissions ?? { defaultMode: "NORMAL" as const, rules: [] };
    if (permissions.rules.some((r) => sameRule(r, rule))) return config;
    return { ...config, permissions: { ...permissions, rules: [...permissions.rules, rule] } };
};

// Appends one rule to the on-disk config by re-reading the raw JSON rather than
// serialising the in-memory Config: keys this build does not know about (older
// or newer schema, hand-added settings) survive the write untouched.
export const persistPermissionRule = async (
    rule: PermissionRule,
    path: string = CONFIG_FILE,
): Promise<boolean> => {
    const file = Bun.file(path);
    const raw: unknown = (await file.exists()) ? await file.json() : null;
    const root = isRecord(raw) ? raw : {};
    const permissions = isRecord(root["permissions"]) ? root["permissions"] : {};
    const rules = Array.isArray(permissions["rules"]) ? (permissions["rules"] as unknown[]) : [];
    if (rules.some((r) => sameRule(r, rule))) return false;
    const defaultMode =
        typeof permissions["defaultMode"] === "string"
            ? permissions["defaultMode"]
            : (DEFAULT_CONFIG.permissions?.defaultMode ?? "NORMAL");
    const next = {
        ...root,
        permissions: { ...permissions, defaultMode, rules: [...rules, rule] },
    };
    await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    return true;
};

export const loadConfig = async (path: string = CONFIG_FILE): Promise<LoadResult> => {
    const file = Bun.file(path);

    if (!(await file.exists())) {
        await writeConfig(path, DEFAULT_CONFIG);
        return { config: DEFAULT_CONFIG, path, created: true };
    }

    const raw: unknown = await file.json();
    const config = validateConfig(raw);
    return { config: mergeDefaultProviders(config), path, created: false };
};

// Existing user configs may pre-date a newly-added provider entry in
// DEFAULT_CONFIG. Merge the missing entries at load time so /provider can
// switch without forcing a manual config edit. The on-disk file is not
// rewritten — users who customize an existing entry keep their version.
const mergeDefaultProviders = (config: Config): Config => {
    const merged = { ...config.providers };
    let added = false;
    for (const [key, value] of Object.entries(DEFAULT_CONFIG.providers)) {
        if (!merged[key]) {
            merged[key] = value;
            added = true;
        }
    }
    return added ? { ...config, providers: merged } : config;
};

export const saveConfig = async (config: Config, path: string = CONFIG_FILE): Promise<void> => {
    await writeConfig(path, config);
};
