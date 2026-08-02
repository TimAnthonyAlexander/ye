import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { YE_DIR } from "../../storage/paths.ts";
import { parseAgentFile, type CustomAgent } from "./parse.ts";

export const USER_AGENTS_DIR = join(YE_DIR, "agents");

export const getProjectAgentsDir = (projectRoot: string): string =>
    join(projectRoot, ".ye", "agents");

const loadDir = (dir: string, source: "project" | "user"): readonly CustomAgent[] => {
    if (!existsSync(dir)) return [];
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }

    const agents: CustomAgent[] = [];
    for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const path = join(dir, entry);
        try {
            if (!statSync(path).isFile()) continue;
        } catch {
            continue;
        }
        let text: string;
        try {
            text = readFileSync(path, "utf8");
        } catch {
            continue;
        }
        const agent = parseAgentFile({
            text,
            path,
            fileName: entry.slice(0, -3),
            source,
        });
        if (agent) agents.push(agent);
    }
    return agents;
};

export const loadAgentsFrom = (userDir: string, projectDir: string): readonly CustomAgent[] => {
    const merged = new Map<string, CustomAgent>();
    for (const agent of loadDir(userDir, "user")) merged.set(agent.name, agent);
    for (const agent of loadDir(projectDir, "project")) merged.set(agent.name, agent);
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
};

export const loadCustomAgents = (projectRoot: string): readonly CustomAgent[] =>
    loadAgentsFrom(USER_AGENTS_DIR, getProjectAgentsDir(projectRoot));
