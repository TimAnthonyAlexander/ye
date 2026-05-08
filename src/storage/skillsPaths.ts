import { homedir } from "node:os";
import { join } from "node:path";
import { YE_DIR } from "./paths.ts";

export const MANAGED_SKILLS_DIR = "/etc/ye/skills";
export const USER_SKILLS_DIR = join(YE_DIR, "skills");
export const CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills");

export const getProjectSkillsDir = (projectRoot: string): string =>
    join(projectRoot, ".ye", "skills");
