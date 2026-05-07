import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_CONFIG } from "./defaults.ts";
import { CONFIG_FILE } from "./paths.ts";
import type { Config } from "./types.ts";
import { validateConfig } from "./validate.ts";

export interface LoadResult {
    readonly config: Config;
    readonly path: string;
    readonly created: boolean;
}

const writeConfig = async (path: string, config: Config): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
    // Tighten perms unconditionally — providers may now persist API keys here.
    // Conditional chmod is a footgun: a later key-less save would loosen the file
    // again. Best-effort: Windows and some FS layouts ignore POSIX modes.
    await chmod(path, 0o600).catch(() => {});
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
