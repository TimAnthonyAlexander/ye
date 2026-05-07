import { mkdir } from "node:fs/promises";
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
};

export const loadConfig = async (path: string = CONFIG_FILE): Promise<LoadResult> => {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    await writeConfig(path, DEFAULT_CONFIG);
    return { config: DEFAULT_CONFIG, path, created: true };
  }

  const raw: unknown = await file.json();
  const config = validateConfig(raw);
  return { config, path, created: false };
};

export const saveConfig = async (
  config: Config,
  path: string = CONFIG_FILE,
): Promise<void> => {
  await writeConfig(path, config);
};
