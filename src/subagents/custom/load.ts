import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { YE_DIR } from "../../storage/paths.ts";
import type { AgentSource } from "../types.ts";
import { parseAgentFile, type CustomAgent } from "./parse.ts";

export const USER_AGENTS_DIR = join(YE_DIR, "agents");
export const CLAUDE_USER_AGENTS_DIR = join(homedir(), ".claude", "agents");

export const getProjectAgentsDir = (projectRoot: string): string =>
    join(projectRoot, ".ye", "agents");

export const getClaudeProjectAgentsDir = (projectRoot: string): string =>
    join(projectRoot, ".claude", "agents");

// Claude Code scans .claude/agents recursively; our own dirs are flat but
// recursing them too is harmless. Bounded depth guards against symlink loops.
const collectMdFiles = (dir: string, depth = 0): readonly string[] => {
    if (depth > 8 || !existsSync(dir)) return [];
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
        const path = join(dir, entry);
        let stat;
        try {
            stat = statSync(path);
        } catch {
            continue;
        }
        if (stat.isDirectory()) {
            files.push(...collectMdFiles(path, depth + 1));
        } else if (stat.isFile() && entry.endsWith(".md")) {
            files.push(path);
        }
    }
    return files;
};

const loadDir = (dir: string, source: AgentSource): readonly CustomAgent[] => {
    const fromClaude = source === "claude-user" || source === "claude-project";
    const agents: CustomAgent[] = [];
    for (const path of collectMdFiles(dir)) {
        let text: string;
        try {
            text = readFileSync(path, "utf8");
        } catch {
            continue;
        }
        const fileName = path.slice(path.lastIndexOf("/") + 1, -3);
        const agent = parseAgentFile({
            text,
            path,
            fileName,
            source,
            nameFromFrontmatter: fromClaude,
        });
        if (agent) agents.push(agent);
    }
    return agents;
};

// Claude Code's agent dirs are read unconditionally alongside Ye's own — most
// users came from Claude Code. Ye's dirs override on name collision, and
// project beats user within each pair.
export const loadCustomAgents = (projectRoot: string): readonly CustomAgent[] => {
    const tiers: ReadonlyArray<readonly CustomAgent[]> = [
        loadDir(CLAUDE_USER_AGENTS_DIR, "claude-user"),
        loadDir(USER_AGENTS_DIR, "user"),
        loadDir(getClaudeProjectAgentsDir(projectRoot), "claude-project"),
        loadDir(getProjectAgentsDir(projectRoot), "project"),
    ];
    const merged = new Map<string, CustomAgent>();
    for (const tier of tiers) {
        for (const agent of tier) merged.set(agent.name, agent);
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
};
