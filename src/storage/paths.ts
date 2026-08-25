import { join } from "node:path";
import { CONFIG_DIR } from "../config/paths.ts";

export const YE_DIR = CONFIG_DIR;
export const PROJECTS_DIR = join(YE_DIR, "projects");
export const HISTORY_FILE = join(YE_DIR, "history.jsonl");
export const USAGE_FILE = join(YE_DIR, "usage.jsonl");
export const GLOBAL_MEMORY_FILE = join(YE_DIR, "MEMORY.md");
export const GLOBAL_MEMORY_DIR = join(YE_DIR, "memory");
export const USER_NOTES_FILE = join(YE_DIR, "CLAUDE.md");
export const USER_PLAN_FILE = join(YE_DIR, "plan.md");
export const MANAGED_NOTES_FILE = "/etc/ye/CLAUDE.md";
export const FREE_MODELS_CACHE_FILE = join(YE_DIR, "free-models.json");

// Language servers are installed under ~/.ye rather than into the user's global
// environment: `rm -rf ~/.ye/lsp` is a complete uninstall, and a bad install
// cannot break a toolchain Ye does not own. Node-based servers get a private
// package root; compiled ones land in bin/.
export const LSP_DIR = join(YE_DIR, "lsp");
export const LSP_BIN_DIR = join(LSP_DIR, "bin");
export const LSP_NODE_DIR = join(LSP_DIR, "node");
export const LSP_NODE_BIN_DIR = join(LSP_NODE_DIR, "node_modules", ".bin");
export const LSP_STATE_FILE = join(LSP_DIR, "state.json");

// Directories to probe before $PATH when resolving a server binary, so a
// Ye-installed server wins over a stale system one.
export const lspSearchDirs = (): readonly string[] => [LSP_BIN_DIR, LSP_NODE_BIN_DIR];

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
