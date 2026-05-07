import { join } from "node:path";
import { CONFIG_DIR } from "../config/paths.ts";

export const YE_DIR = CONFIG_DIR;
export const PROJECTS_DIR = join(YE_DIR, "projects");
export const HISTORY_FILE = join(YE_DIR, "history.jsonl");
export const GLOBAL_MEMORY_FILE = join(YE_DIR, "MEMORY.md");
export const GLOBAL_MEMORY_DIR = join(YE_DIR, "memory");
export const USER_NOTES_FILE = join(YE_DIR, "CLAUDE.md");

export const getProjectDir = (projectId: string): string => join(PROJECTS_DIR, projectId);
export const getProjectMetaPath = (projectId: string): string =>
  join(getProjectDir(projectId), "meta.json");
export const getProjectSessionsDir = (projectId: string): string =>
  join(getProjectDir(projectId), "sessions");
export const getProjectPlansDir = (projectId: string): string =>
  join(getProjectDir(projectId), "plans");
export const getProjectMemoryDir = (projectId: string): string =>
  join(getProjectDir(projectId), "memory");
