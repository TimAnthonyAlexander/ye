import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { getProjectDir, getProjectMetaPath } from "./paths.ts";

const ROOT_MARKERS = [".git", "package.json", "composer.json", "CLAUDE.md", "YE.md"] as const;

export interface ProjectId {
  readonly id: string;
  readonly root: string;
}

interface ProjectMeta {
  readonly originalCwd: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

const findProjectRoot = (start: string): string => {
  let dir = resolve(start);
  while (true) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(`${dir}${sep}${marker}`)) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
};

const hashPath = (path: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(path);
  return hasher.digest("hex").slice(0, 12);
};

const writeMeta = async (projectId: string, root: string): Promise<void> => {
  const path = getProjectMetaPath(projectId);
  await mkdir(getProjectDir(projectId), { recursive: true });
  const now = new Date().toISOString();
  const file = Bun.file(path);

  let createdAt = now;
  if (await file.exists()) {
    try {
      const prev = (await file.json()) as Partial<ProjectMeta>;
      if (typeof prev.createdAt === "string") createdAt = prev.createdAt;
    } catch {
      // overwrite on parse failure
    }
  }

  const meta: ProjectMeta = { originalCwd: root, createdAt, lastSeenAt: now };
  await Bun.write(path, `${JSON.stringify(meta, null, 2)}\n`);
};

let cached: ProjectId | null = null;

export const getProjectId = async (cwd: string = process.cwd()): Promise<ProjectId> => {
  if (cached) return cached;
  const root = findProjectRoot(cwd);
  const id = hashPath(root);
  await writeMeta(id, root);
  cached = { id, root };
  return cached;
};

// Test-only: clear the cache so unit tests can resolve fresh project ids.
export const _resetProjectCache = (): void => {
  cached = null;
};
