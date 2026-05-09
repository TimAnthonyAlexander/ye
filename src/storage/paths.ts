import { join } from "node:path";
import { CONFIG_DIR } from "../config/paths.ts";

export const YE_DIR = CONFIG_DIR;
export const PROJECTS_DIR = join(YE_DIR, "projects");
export const HISTORY_FILE = join(YE_DIR, "history.jsonl");
export const USAGE_FILE = join(YE_DIR, "usage.jsonl");
export const GLOBAL_MEMORY_FILE = join(YE_DIR, "MEMORY.md");
export const GLOBAL_MEMORY_DIR = join(YE_DIR, "memory");
export const USER_NOTES_FILE = join(YE_DIR, "CLAUDE.md");
export const MANAGED_NOTES_FILE = "/etc/ye/CLAUDE.md";

export const getProjectDir = (projectId: string): string => join(PROJECTS_DIR, projectId);
export const getProjectMetaPath = (projectId: string): string =>
    join(getProjectDir(projectId), "meta.json");
export const getProjectSessionsDir = (projectId: string): string =>
    join(getProjectDir(projectId), "sessions");
export const getProjectPlansDir = (projectId: string): string =>
    join(getProjectDir(projectId), "plans");
export const getProjectMemoryDir = (projectId: string): string =>
    join(getProjectDir(projectId), "memory");
export const getSidechainSessionsDir = (projectId: string, parentSessionId: string): string =>
    join(getProjectSessionsDir(projectId), parentSessionId, "sidechains");
export const getProjectCheckpointsDir = (projectId: string): string =>
    join(getProjectDir(projectId), "checkpoints");
export const getSessionCheckpointsDir = (projectId: string, sessionId: string): string =>
    join(getProjectCheckpointsDir(projectId), sessionId);
export const getTurnCheckpointDir = (
    projectId: string,
    sessionId: string,
    turnIndex: number,
): string => join(getSessionCheckpointsDir(projectId, sessionId), String(turnIndex));
